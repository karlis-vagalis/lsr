import type { Config } from "./config";
import type { Ref, Similarity, SourceId, UpdatedAt } from "./domain";
import type { PluginRegistry } from "./registry";

/** A searchable item (one document or one file) exposed by a source. */
export type SourceItem = {
	ref: Ref;
	updatedAt: UpdatedAt;
	name: string;
	url: string;
};

/**
 * A unified content source, produced by a plugin. A source yields searchable
 * text for items and can signal changes via `onChange` (polling is the core's
 * reliable base; webhooks just nudge it sooner).
 */
export interface Source {
	id: SourceId;
	label: string;
	list(): Promise<SourceItem[]>;
	getContent(ref: Ref): Promise<{ text: string } | null>;
	onChange?(cb: () => void): void;
}

/**
 * Build the runtime sources for every configured entry by asking its plugin
 * to construct them. A misbehaving source is reported and skipped, so one bad
 * entry never stops the rest.
 */
export function buildSources(
	registry: PluginRegistry,
	cfg: Config,
): { sources: Source[]; errors: string[] } {
	const sources: Source[] = [];
	const errors: string[] = [];
	for (const entry of cfg.sources) {
		try {
			const plugin = registry.get(entry.pluginId);
			const parsed = plugin.config.parse(entry.fields);
			sources.push(...plugin.createSources(parsed));
		} catch (err) {
			const name =
				typeof entry.fields === "object" && entry.fields
					? String((entry.fields as { name?: unknown }).name ?? "?")
					: "?";
			errors.push(`[${entry.pluginId}:"${name}"] ${(err as Error).message}`);
		}
	}
	return { sources, errors };
}

export type SearchHit = {
	source: SourceId;
	documentId: Ref;
	name: string;
	chunk: string;
	score: Similarity;
	url: string;
};
