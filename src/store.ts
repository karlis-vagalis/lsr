import { Database } from "bun:sqlite";
import type { Config } from "./config";
import {
	type Embedding,
	type Ref,
	type Similarity,
	type SourceId,
	similarity,
	type UpdatedAt,
} from "./domain";
import type { SearchHit } from "./types";

/**
 * Multi-source vector store (bun:sqlite). Vectors stored as float32 blobs,
 * searched by brute-force cosine (sub-ms at archive scale).
 */
export class VectorStore {
	private db: Database;
	private insertChunkStmt;
	private deleteDocStmt;
	private upsertMetaStmt;
	private getMetaStmt;
	private selectRefsStmt;
	private selectAllStmt;

	constructor(cfg: Config) {
		this.db = new Database(cfg.search.dbPath);
		this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS chunks (
        source     TEXT NOT NULL,
        doc_id     TEXT NOT NULL,
        idx        INTEGER NOT NULL,
        text       TEXT NOT NULL,
        vec        BLOB NOT NULL,
        name       TEXT NOT NULL,
        url        TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (source, doc_id, idx)
      );
      CREATE TABLE IF NOT EXISTS meta (
        source     TEXT NOT NULL,
        doc_id     TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (source, doc_id)
      );
      CREATE INDEX IF NOT EXISTS idx_chunks_source ON chunks(source);
    `);
		this.insertChunkStmt = this.db.prepare(
			`INSERT OR REPLACE INTO chunks (source, doc_id, idx, text, vec, name, url, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		);
		this.deleteDocStmt = this.db.prepare(
			"DELETE FROM chunks WHERE source = ? AND doc_id = ?",
		);
		this.upsertMetaStmt = this.db.prepare(
			`INSERT INTO meta (source, doc_id, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(source, doc_id) DO UPDATE SET updated_at = excluded.updated_at`,
		);
		this.getMetaStmt = this.db.prepare(
			"SELECT updated_at FROM meta WHERE source = ? AND doc_id = ?",
		);
		this.selectRefsStmt = this.db.prepare(
			"SELECT DISTINCT doc_id FROM chunks WHERE source = ?",
		);
		this.selectAllStmt = this.db.prepare(
			"SELECT source, doc_id, text, name, url, vec FROM chunks",
		);
	}

	close() {
		this.db.close();
	}

	lastIndexed(source: SourceId, docId: Ref): UpdatedAt | null {
		const row = this.getMetaStmt.get(source, docId) as {
			updated_at: string;
		} | null;
		return row ? (row.updated_at as UpdatedAt) : null;
	}

	upsertDocument(
		source: SourceId,
		doc: { id: Ref; updatedAt: UpdatedAt; name: string; url: string },
		chunks: { text: string; vec: Embedding }[],
	) {
		this.db.transaction(() => {
			this.deleteDocStmt.run(source, doc.id);
			chunks.forEach((c, i) => {
				this.insertChunkStmt.run(
					source,
					doc.id,
					i,
					c.text,
					new Uint8Array(c.vec.buffer, c.vec.byteOffset, c.vec.byteLength),
					doc.name,
					doc.url,
					doc.updatedAt,
				);
			});
			this.upsertMetaStmt.run(source, doc.id, doc.updatedAt);
		})();
	}

	/** Mark a doc as processed even with zero chunks (so we stop re-fetching). */
	markIndexed(source: SourceId, docId: Ref, updatedAt: UpdatedAt) {
		this.db.transaction(() => {
			this.deleteDocStmt.run(source, docId);
			this.upsertMetaStmt.run(source, docId, updatedAt);
		})();
	}

	removeDocument(source: SourceId, docId: Ref) {
		this.db.transaction(() => {
			this.deleteDocStmt.run(source, docId);
			this.db
				.prepare("DELETE FROM meta WHERE source = ? AND doc_id = ?")
				.run(source, docId);
		})();
	}

	referencedIds(source: SourceId): Ref[] {
		const rows = this.selectRefsStmt.all(source) as { doc_id: string }[];
		return rows.map((r) => r.doc_id as Ref);
	}

	count() {
		const d = this.db
			.query(
				"SELECT source, COUNT(DISTINCT doc_id) AS n FROM chunks GROUP BY source",
			)
			.all() as {
			source: string;
			n: number;
		}[];
		const c = this.db.query("SELECT COUNT(*) AS n FROM chunks").get() as {
			n: number;
		};
		return {
			bySource: Object.fromEntries(d.map((r) => [r.source, r.n])),
			chunks: c.n,
		};
	}

	search(queryVec: Embedding, k: number, sourceFilter?: SourceId): SearchHit[] {
		const rows = this.selectAllStmt.all() as {
			source: string;
			doc_id: string;
			text: string;
			name: string;
			url: string;
			vec: Uint8Array;
		}[];
		const q = queryVec;
		const scored: { s: Similarity; hit: Omit<SearchHit, "score"> }[] = [];
		for (const row of rows) {
			if (sourceFilter && row.source !== sourceFilter) continue;
			const v = new Float32Array(
				row.vec.buffer,
				row.vec.byteOffset,
				row.vec.byteLength / 4,
			);
			let dot = 0,
				nq = 0,
				nv = 0;
			for (let i = 0; i < q.length; i++) {
				dot += q[i] * v[i];
				nq += q[i] * q[i];
				nv += v[i] * v[i];
			}
			const s = similarity(dot / (Math.sqrt(nq) * Math.sqrt(nv) || 1));
			scored.push({
				s,
				hit: {
					source: row.source as SourceId,
					documentId: row.doc_id as Ref,
					name: row.name,
					chunk: row.text,
					url: row.url,
				},
			});
		}
		scored.sort((a, b) => b.s - a.s);
		return scored.slice(0, k).map(({ s, hit }) => ({ ...hit, score: s }));
	}
}
