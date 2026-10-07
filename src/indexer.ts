import type { Config } from "./config";
import type { Ref, SourceId } from "./domain";
import { chunkText, embedTexts } from "./embed";
import type { VectorStore } from "./store";
import type { SearchHit, Source, SourceItem } from "./types";

export type SyncSummary = {
	source: string;
	indexed: number;
	updated: number;
	removed: number;
};

/** Indexes a single source: embed changed items, drop vanished ones. */
export async function syncSource(
	cfg: Config,
	store: VectorStore,
	source: Source,
): Promise<SyncSummary> {
	const summary: SyncSummary = {
		source: source.id,
		indexed: 0,
		updated: 0,
		removed: 0,
	};
	let items: SourceItem[];
	try {
		items = await source.list();
	} catch (err) {
		console.error(
			`[${source.id}] list failed, skipping:`,
			(err as Error).message,
		);
		return summary;
	}

	const active = new Set<Ref>();
	const toIndex: { item: SourceItem; content: string }[] = [];

	for (const item of items) {
		active.add(item.ref);
		if (store.lastIndexed(source.id, item.ref) === item.updatedAt) continue;
		try {
			const got = await source.getContent(item.ref);
			if (!got) {
				// no text yet (async extraction / binary): don't mark, retry next pass
				continue;
			}
			toIndex.push({ item, content: got.text });
		} catch (err) {
			console.error(
				`[${source.id}] content failed for ${item.ref}:`,
				(err as Error).message,
			);
		}
	}

	for (const { item, content } of toIndex) {
		const existed = store.lastIndexed(source.id, item.ref) !== null;
		const chunks = chunkText(
			content,
			cfg.search.chunkChars,
			cfg.search.chunkOverlap,
		);
		if (chunks.length === 0) {
			store.markIndexed(source.id, item.ref, item.updatedAt); // empty text, stop retrying
			if (existed) summary.updated += 1;
			else summary.indexed += 1;
			continue;
		}
		const vec = await embedTexts(cfg, chunks);
		store.upsertDocument(
			source.id,
			{
				id: item.ref,
				updatedAt: item.updatedAt,
				name: item.name,
				url: item.url,
			},
			chunks.map((text, i) => ({ text, vec: vec[i] })),
		);
		if (existed) summary.updated += 1;
		else summary.indexed += 1;
	}

	// Drop refs that vanished from this source (deleted/trashed/renamed files)
	const referenced = store.referencedIds(source.id);
	for (const id of referenced) {
		if (!active.has(id)) {
			store.removeDocument(source.id, id);
			summary.removed += 1;
		}
	}

	const { bySource } = store.count();
	console.log(
		`[${source.id}] +${summary.indexed} new, ~${summary.updated} updated, -${summary.removed} removed ` +
			`| ${bySource[source.id] ?? 0} docs`,
	);
	return summary;
}

/** Sync every configured source. */
export async function syncAll(
	cfg: Config,
	store: VectorStore,
	sources: Source[],
): Promise<SyncSummary[]> {
	const out: SyncSummary[] = [];
	for (const s of sources) out.push(await syncSource(cfg, store, s));
	const { bySource, chunks } = store.count();
	console.log(
		`[sync] total: ${Object.values(bySource).reduce((a: number, b: number) => a + b, 0)} docs / ${chunks} chunks`,
	);
	return out;
}

/** Embed a query and search across sources. */
export async function query(
	cfg: Config,
	store: VectorStore,
	q: string,
	k: number,
	sourceFilter?: SourceId,
): Promise<SearchHit[]> {
	const vec = await embedTexts(cfg, [q]);
	return store.search(vec[0] as import("./domain").Embedding, k, sourceFilter);
}
