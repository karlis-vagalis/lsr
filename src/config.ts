import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { parse, stringify } from "yaml";
import { z } from "zod";
import type { PluginRegistry } from "./registry";

export type SearchCfg = {
	model: string;
	dtype: "q4" | "q8" | "fp16" | "fp32";
	dbPath: string;
	host: string;
	port: number;
	pollIntervalSec: number;
	chunkChars: number;
	chunkOverlap: number;
	webhookSecret: string;
};

/** One configured source: which plugin built it + its parsed fields. */
export type SourceConfig = {
	pluginId: string;
	fields: Record<string, unknown>;
};

export type Config = {
	sources: SourceConfig[];
	search: SearchCfg;
};

export const DEFAULT_CONFIG_PATH = "lsr.config.yaml";

const SEARCH_DEFAULTS: SearchCfg = {
	model: "onnx-community/embeddinggemma-2-ONNX",
	dtype: "q4",
	dbPath: "./lsr.sqlite",
	host: "127.0.0.1",
	port: 4747,
	pollIntervalSec: 60,
	chunkChars: 1800,
	chunkOverlap: 120,
	webhookSecret: "",
};

const searchSchema = z.object({
	model: z.string().default(SEARCH_DEFAULTS.model),
	dtype: z.enum(["q4", "q8", "fp16", "fp32"]).default(SEARCH_DEFAULTS.dtype),
	dbPath: z.string().default(SEARCH_DEFAULTS.dbPath),
	host: z.string().default(SEARCH_DEFAULTS.host),
	port: z.coerce.number().default(SEARCH_DEFAULTS.port),
	pollInterval: z.coerce.number().default(SEARCH_DEFAULTS.pollIntervalSec),
	chunkChars: z.coerce.number().default(SEARCH_DEFAULTS.chunkChars),
	chunkOverlap: z.coerce.number().default(SEARCH_DEFAULTS.chunkOverlap),
	webhookSecret: z.string().default(""),
});
const searchInputSchema = searchSchema.partial();

const DTYPES = ["q4", "q8", "fp16", "fp32"] as const;

function envStr(n: string): string | undefined {
	const v = process.env[n];
	return v === undefined || v === "" ? undefined : v;
}

/** Render a ZodError as a compact, human-readable message. */
export function summarizeZod(err: z.ZodError): string {
	return err.issues
		.map((i) => {
			const p = i.path.length ? i.path.join(".") : "value";
			return `${p}: ${i.message}`;
		})
		.join("; ");
}

export function defaultConfig(): Config {
	return { sources: [], search: { ...SEARCH_DEFAULTS } };
}

/**
 * Parse one `sources:` entry: discover its plugin, then let that plugin's
 * (strict) Zod schema validate + coerce its fields. Throwing here means an
 * invalid entry fails fast with a precise message.
 */
function parseSourceEntry(
	registry: PluginRegistry,
	raw: unknown,
): SourceConfig {
	const envelope = z
		.object({ plugin: z.string().min(1, "plugin is required") })
		.passthrough()
		.safeParse(raw);
	if (!envelope.success) {
		throw new Error(`invalid source entry: ${summarizeZod(envelope.error)}`);
	}
	const { plugin, ...fields } = envelope.data as { plugin: string } & Record<
		string,
		unknown
	>;
	const sourcePlugin = registry.get(plugin);
	const parsed = sourcePlugin.config.safeParse(fields);
	if (!parsed.success) {
		throw new Error(
			`source "${plugin}" is invalid: ${summarizeZod(parsed.error)}`,
		);
	}
	return { pluginId: plugin, fields: parsed.data as Record<string, unknown> };
}

/**
 * Load and validate the config file. Sources are validated against each
 * plugin's schema and `search` against a Zod schema; env (`LSR_*`) overrides
 * are applied last.
 */
export function loadConfig(
	registry: PluginRegistry,
	configPath: string = DEFAULT_CONFIG_PATH,
): Config {
	const cfg = defaultConfig();
	if (existsSync(configPath)) {
		const raw = parse(readFileSync(configPath, "utf8"));
		if (raw && typeof raw === "object") {
			const root = raw as Record<string, unknown>;
			cfg.search = {
				...SEARCH_DEFAULTS,
				...searchInputSchema.parse(root.search ?? {}),
			};
			if (Array.isArray(root.sources)) {
				cfg.sources = root.sources.map((e) => parseSourceEntry(registry, e));
			}
		}
	}
	// env overrides (last)
	const model = envStr("LSR_EMBED_MODEL");
	if (model) cfg.search.model = model;
	const dtype = envStr("LSR_EMBED_DTYPE");
	if (dtype) cfg.search.dtype = z.enum(DTYPES).parse(dtype);
	const dbPath = envStr("LSR_DB_PATH");
	if (dbPath) cfg.search.dbPath = dbPath;
	const host = envStr("LSR_HOST");
	if (host) cfg.search.host = host;
	const port = envStr("LSR_PORT");
	if (port) cfg.search.port = z.coerce.number().parse(port);
	const poll = envStr("LSR_POLL_INTERVAL");
	if (poll) cfg.search.pollIntervalSec = z.coerce.number().parse(poll);
	const secret = envStr("LSR_WEBHOOK_SECRET");
	if (secret) cfg.search.webhookSecret = secret;
	return cfg;
}

/**
 * Add a source for `pluginId` from CLI flag values (strings) and persist.
 * The plugin's schema coerces types and rejects unknown/missing fields.
 */
export function addSource(
	registry: PluginRegistry,
	pluginId: string,
	values: Record<string, string>,
	configPath: string = DEFAULT_CONFIG_PATH,
): void {
	const sourcePlugin = registry.get(pluginId);
	const parsed = sourcePlugin.config.safeParse(values);
	if (!parsed.success) {
		throw new Error(`add ${pluginId}: ${summarizeZod(parsed.error)}`);
	}
	const fields = parsed.data as Record<string, unknown>;
	const name = String(fields.name);
	const cfg = loadConfig(registry, configPath);
	if (
		cfg.sources.some((s) => s.pluginId === pluginId && s.fields.name === name)
	) {
		throw new Error(`${pluginId} source "${name}" already exists`);
	}
	cfg.sources.push({ pluginId, fields });
	writeConfig(registry, cfg, configPath);
}

export function toYamlShape(cfg: Config) {
	return {
		sources: cfg.sources.map((s) => ({
			plugin: s.pluginId,
			...s.fields,
		})),
		search: {
			model: cfg.search.model,
			dtype: cfg.search.dtype,
			dbPath: cfg.search.dbPath,
			host: cfg.search.host,
			port: cfg.search.port,
			pollInterval: cfg.search.pollIntervalSec,
			chunkChars: cfg.search.chunkChars,
			chunkOverlap: cfg.search.chunkOverlap,
			...(cfg.search.webhookSecret
				? { webhookSecret: cfg.search.webhookSecret }
				: {}),
		},
	};
}

export function writeConfig(
	_registry: PluginRegistry,
	cfg: Config,
	configPath: string = DEFAULT_CONFIG_PATH,
): void {
	writeFileSync(
		configPath,
		`${stringify(toYamlShape(cfg), { indent: 2 })}\n`,
		"utf8",
	);
}

export function configPathFromArgs(args: string[]): string {
	const m = args.find((a) => a.startsWith("--config="));
	return m ? m.split("=")[1] : (process.env.LSR_CONFIG ?? DEFAULT_CONFIG_PATH);
}

export function printConfig(cfg: Config) {
	console.log("lsr config");
	for (const s of cfg.sources) {
		const name = s.fields.name;
		const extra = Object.entries(s.fields)
			.filter(([k]) => k !== "name")
			.map(([k]) => `${k}=${JSON.stringify(s.fields[k])}`)
			.join(" ");
		console.log(`  [${s.pluginId}] ${name}${extra ? `  (${extra})` : ""}`);
	}
	if (cfg.sources.length === 0) console.log("  (no sources)");
	console.log(`  model       : ${cfg.search.model} (${cfg.search.dtype})`);
	console.log(`  db          : ${cfg.search.dbPath}`);
	console.log(`  http        : http://${cfg.search.host}:${cfg.search.port}`);
	console.log(`  poll        : ${cfg.search.pollIntervalSec}s`);
}
