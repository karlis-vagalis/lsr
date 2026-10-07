#!/usr/bin/env bun
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { defineCommand, runMain } from "citty";
import {
	addSource,
	DEFAULT_CONFIG_PATH,
	loadConfig,
	printConfig,
} from "./config";
import type { SourceId } from "./domain";
import { query, syncAll } from "./indexer";
import { loadDefaultRegistry } from "./registry";
import { startServer } from "./server";
import {
	describeService,
	installService,
	type Scope,
	serviceStatus,
	uninstallService,
} from "./service";
import { VectorStore } from "./store";
import { buildSources } from "./types";

const EXAMPLE_CONFIG = `# lsr.config.yaml — local semantic search, plugin-driven sources
# Any configured source names a plugin; the plugin's own schema validates it.
sources:
  - plugin: folder
    name: notes
    path: ~/Documents/notes
    pattern: "**/*.md"
  - plugin: papra
    name: home
    url: http://localhost:8787
    apiKey: replace-me
  - plugin: himalaya
    name: work
    mailbox: INBOX
search:
  model: onnx-community/embeddinggemma-2-ONNX
  dtype: q4
  dbPath: ./lsr.sqlite
  host: 127.0.0.1
  port: 4747
  pollInterval: 60
`;

/** Convert "api-key" -> "apiKey" so plugin field names align with their schemas. */
function toCamel(key: string): string {
	return key.replace(/-([a-z0-9])/g, (_m, c: string) => c.toUpperCase());
}

/** Resolve the config path for a command: --config > $LSR_CONFIG > default. */
function cfgFile(args: object): string {
	const c = (args as { config?: unknown }).config;
	return (
		(typeof c === "string" ? c : process.env.LSR_CONFIG) || DEFAULT_CONFIG_PATH
	);
}

/** Shared option for pointing any command at a specific config file. */
const configOpt = {
	type: "string" as const,
	valueHint: "PATH",
	description: `Config file (default: ${DEFAULT_CONFIG_PATH} or $LSR_CONFIG)`,
	alias: ["c"],
};

async function main() {
	const registry = await loadDefaultRegistry();
	const pkg = (await Bun.file(resolve(import.meta.dir, "../package.json"))
		.json()
		.catch(() => ({ version: "0.1.0" }))) as { version: string };

	const mainCommand = defineCommand({
		meta: {
			name: "lsr",
			version: pkg.version,
			description:
				"Local semantic search over plugin sources (EmbeddingGemma 2)",
		},
		subCommands: {
			serve: defineCommand({
				meta: {
					name: "serve",
					description: "Start daemon (poll + HTTP :4747 + webhook)",
				},
				args: { config: configOpt },
				run: async ({ args }) => {
					const cfg = loadConfig(registry, cfgFile(args));
					const store = new VectorStore(cfg);
					const { sources, errors } = buildSources(registry, cfg);
					printConfig(cfg);
					for (const e of errors) console.error(e);
					await startServer({
						cfg,
						store,
						sources,
						registry,
						stopRef: { current: false },
					});
				},
			}),
			reindex: defineCommand({
				meta: { name: "reindex", description: "One full sync pass, then exit" },
				args: { config: configOpt },
				run: async ({ args }) => {
					const cfg = loadConfig(registry, cfgFile(args));
					const store = new VectorStore(cfg);
					const { sources, errors } = buildSources(registry, cfg);
					for (const e of errors) console.error(e);
					await syncAll(cfg, store, sources);
					store.close();
				},
			}),
			search: defineCommand({
				meta: { name: "search", description: "Semantic search across sources" },
				args: {
					query: {
						type: "positional",
						description: "Free-text query (quote it)",
						required: true,
					},
					k: { type: "string", description: "Top-K results", default: "10" },
					source: {
						type: "string",
						valueHint: "folder:notes",
						description: "Filter results to one source",
					},
					config: configOpt,
				},
				run: async ({ args }) => {
					const cfg = loadConfig(registry, cfgFile(args));
					const store = new VectorStore(cfg);
					const { errors } = buildSources(registry, cfg);
					for (const e of errors) console.error(e);
					const k = Number(args.k) || 10;
					const filter = args.source
						? (toCamel(args.source) as SourceId)
						: undefined;
					const results = await query(cfg, store, args.query, k, filter);
					for (const r of results) {
						console.log(`\n[${r.score.toFixed(3)}] [${r.source}] ${r.name}`);
						console.log("  ", r.chunk.slice(0, 200));
						console.log("  ", r.url);
					}
					store.close();
				},
			}),
			status: defineCommand({
				meta: { name: "status", description: "Index stats per source" },
				args: { config: configOpt },
				run: async ({ args }) => {
					const cfg = loadConfig(registry, cfgFile(args));
					const store = new VectorStore(cfg);
					printConfig(cfg);
					console.log("\nindex:", store.count());
					store.close();
				},
			}),
			sources: defineCommand({
				meta: { name: "sources", description: "List configured sources" },
				args: { config: configOpt },
				run: async ({ args }) => {
					const cfg = loadConfig(registry, cfgFile(args));
					printConfig(cfg);
				},
			}),
			plugins: defineCommand({
				meta: { name: "plugins", description: "List registered plugins" },
				run: async () => {
					for (const p of registry.all()) {
						const keys = Object.keys(
							(p.config as { shape?: Record<string, unknown> }).shape ?? {},
						).join(", ");
						console.log(
							`  ${p.id}  — ${p.label}${keys ? `  (config: ${keys})` : ""}`,
						);
					}
				},
			}),
			add: defineCommand({
				meta: { name: "add", description: "Add a source for a plugin" },
				args: {
					plugin: {
						type: "positional",
						description: "Plugin id (see `lsr plugins`)",
						required: true,
					},
					config: configOpt,
				},
				run: async ({ args }) => {
					const pluginId = args.plugin;
					if (!registry.has(pluginId)) {
						console.error(
							`unknown plugin "${pluginId}". Registered: ${registry
								.all()
								.map((p) => p.id)
								.join(", ")}`,
						);
						process.exit(1);
					}
					// unknown --field=value flags arrive as kebab-case keys; camelCase them
					const fields: Record<string, string> = {};
					for (const [key, val] of Object.entries(args)) {
						if (
							key === "plugin" ||
							key === "config" ||
							key === "c" ||
							key === "_"
						)
							continue;
						if (typeof val === "string") fields[toCamel(key)] = val;
					}
					addSource(registry, pluginId, fields, cfgFile(args));
					console.log(`added ${pluginId} source "${fields.name ?? "?"}"`);
				},
			}),
			service: defineCommand({
				meta: { name: "service", description: "Manage the systemd service" },
				args: { config: configOpt },
				subCommands: {
					install: defineCommand({
						meta: {
							name: "install",
							description: "Install + start the lsr.service unit",
						},
						args: {
							system: {
								type: "boolean",
								description: "Install system-wide (default: user)",
							},
							config: configOpt,
						},
						run: async ({ args }) => {
							const scope: Scope = args.system ? "system" : "user";
							const config = resolve(
								args.config ??
									process.env.LSR_CONFIG ??
									join(homedir(), ".config", "lsr", "config.yaml"),
							);
							installService({ scope, config });
						},
					}),
					uninstall: defineCommand({
						meta: {
							name: "uninstall",
							description: "Stop + remove the lsr.service unit",
						},
						args: {
							system: {
								type: "boolean",
								description: "Remove system-wide unit (default: user)",
							},
						},
						run: async ({ args }) => {
							const scope: Scope = args.system ? "system" : "user";
							uninstallService(scope);
						},
					}),
					status: defineCommand({
						meta: { name: "status", description: "Show service status" },
						args: {
							system: {
								type: "boolean",
								description: "Inspect system-wide unit (default: user)",
							},
						},
						run: async ({ args }) => {
							const scope: Scope = args.system ? "system" : "user";
							console.log(describeService(scope));
							serviceStatus(scope);
						},
					}),
				},
			}),
			env: defineCommand({
				meta: { name: "env", description: "Print a sample lsr.config.yaml" },
				run: async () => {
					console.log(EXAMPLE_CONFIG);
				},
			}),
		},
	});

	await runMain(mainCommand);
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
