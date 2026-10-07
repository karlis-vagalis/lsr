import { statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { z } from "zod";
import { parseUpdatedAt, type Ref, type SourceId } from "../../src/domain";
import { definePlugin, nameField } from "../../src/plugin";
import type { Source, SourceItem } from "../../src/types";

const folderConfig = z
	.object({
		name: nameField,
		path: z.string().min(1, "path is required"),
		pattern: z.string().default("**/*.md"),
	})
	.strict();

type FolderConfig = z.infer<typeof folderConfig>;

const TEXT_EXT = new Set([
	"md",
	"markdown",
	"txt",
	"text",
	"log",
	"rst",
	"adoc",
	"json",
	"jsonl",
	"yaml",
	"yml",
	"toml",
	"ini",
	"conf",
	"cfg",
	"html",
	"htm",
	"xml",
	"csv",
	"tsv",
	"css",
	"scss",
	"js",
	"ts",
	"jsx",
	"tsx",
	"py",
	"rs",
	"go",
	"java",
	"sh",
	"bash",
	"env",
	"gitignore",
	"sql",
]);

class FolderSource implements Source {
	readonly id: SourceId;
	readonly label: string;
	private absRoot: string;

	constructor(private cfg: FolderConfig) {
		this.id = `folder:${cfg.name}` as SourceId;
		this.label = `folder "${cfg.name}"`;
		this.absRoot = resolve(cfg.path);
	}

	private async *walk(): AsyncGenerator<SourceItem> {
		const glob = new Bun.Glob(this.cfg.pattern || "**/*.md");
		for (const rel of glob.scanSync({ cwd: this.absRoot, onlyFiles: true })) {
			const abs = join(this.absRoot, rel);
			let mtimeMs: number;
			try {
				mtimeMs = statSync(abs).mtimeMs;
			} catch {
				continue; // vanished during scan
			}
			const ext = rel.split(".").pop()?.toLowerCase() ?? "";
			if (!TEXT_EXT.has(ext)) continue; // text-only for now
			yield {
				ref: abs as Ref,
				updatedAt: parseUpdatedAt(mtimeMs),
				name: relative(this.absRoot, abs),
				url: `file://${abs}`,
			};
		}
	}

	async list(): Promise<SourceItem[]> {
		const items: SourceItem[] = [];
		for await (const it of this.walk()) items.push(it);
		return items;
	}

	async getContent(ref: Ref): Promise<{ text: string } | null> {
		try {
			// skip binary by checking for NUL bytes in a prefix
			const file = Bun.file(ref);
			const head = new Uint8Array(await file.slice(0, 4096).arrayBuffer());
			if (head.includes(0)) return null; // binary
			const text = await file.text();
			if (!text.trim()) return null;
			return { text };
		} catch {
			return null;
		}
	}

	onChange(): void {
		// fs.watch is OS-dependent and noisy across tools; polling every interval
		// is the reliable base. Nothing to register here yet.
	}
}

export default definePlugin<typeof folderConfig>({
	id: "folder",
	label: "Local folders (glob)",
	description: "Index text files under a path using a glob pattern.",
	config: folderConfig,
	createSources(cfg) {
		return [new FolderSource(cfg)];
	},
});
