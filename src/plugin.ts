import { z } from "zod";
import type { SourceId } from "./domain";
import type { Source } from "./types";

/**
 * Shared schema for the `name` field every configured source must carry.
 * The name is the human identifier used in per-source ids (`<plugin>:<name>`)
 * and in error/log messages.
 */
export const nameField = z.string().min(1, "name is required");

/**
 * Context passed to a plugin's optional webhook handler. Core fills `secret`
 * with the global `search.webhookSecret` so plugins can fall back to it
 * (plugins may also define their own per-source secret in their config).
 */
export type WebhookContext = {
	body: unknown;
	rawBody: string;
	headers: Headers;
	secret?: string;
};

/**
 * A source plugin. Plugins bring their own Zod config schema and build
 * runtime `Source` objects; the core owns indexing, storage, embedding and
 * search and treats every plugin uniformly.
 *
 * To register a plugin it just needs to be the default export of its
 * `plugins/<id>/index.ts` module — the registry loads every plugin folder
 * on startup and registers them all by default.
 */
export interface SourcePlugin<T extends z.ZodTypeAny = z.ZodTypeAny> {
	/** Unique plugin id (e.g. "folder", "papra", "himalaya"). */
	id: string;
	label: string;
	description?: string;
	/**
	 * Zod schema for one configured source. Must include `name` and should be
	 * `.strict()` so unknown config keys fail fast. Use `z.coerce.*` for
	 * numeric fields so the CLI (`--key=value`) and YAML agree on types.
	 */
	config: T;
	/** Build the runtime `Source`(s) for one parsed config entry. */
	createSources(parsed: z.infer<T>): Source[];
	/**
	 * Handle an inbound webhook. Return the source ids whose content may have
	 * changed (core nudges a re-sync), or null if this plugin doesn't own the
	 * event. Authentication/signature verification is the plugin's job.
	 */
	matchWebhook?(ctx: WebhookContext): SourceId[] | null;
}

/** Type helper for authoring a plugin object with inferred config types. */
export function definePlugin<T extends z.ZodTypeAny>(
	plugin: SourcePlugin<T>,
): SourcePlugin<T> {
	return plugin;
}
