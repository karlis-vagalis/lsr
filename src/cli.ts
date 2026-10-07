import {
	addSource,
	configPathFromArgs,
	loadConfig,
	printConfig,
} from "./config";
import type { SourceId } from "./domain";
import { query, syncAll } from "./indexer";
import { loadDefaultRegistry } from "./registry";
import { startServer } from "./server";
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
    # organizationId: (optional, auto-detected if one org)
    # webhookSecret: (optional, per-source signature secret)
  - plugin: himalaya
    name: work
    # account: work   # himalaya account profile
    # mailbox: INBOX  # mailbox to index
    # limit: 200      # max recent messages
# search:
#   model: onnx-community/embeddinggemma-2-ONNX
#   dtype: q4
#   dbPath: ./lsr.sqlite
#   port: 4747
#   pollInterval: 60
#   webhookSecret: (optional — shared signature secret for plugins)
`;

function usage() {
	console.log(`lsr — local semantic search over plugin sources (EmbeddingGemma 2)

Usage:
  lsr serve                         Start daemon (poll + HTTP :4747 + webhook)
  lsr reindex                       One full sync pass, then exit
  lsr search "<query>" [--k=10] [--source=folder:notes] (default --k=10)
  lsr status                        Index stats per source
  lsr sources                       List configured sources
  lsr plugins                       List registered plugins
  lsr add <plugin> --name=x ...     Add a source for a plugin (see its schema)
  lsr env                           Print a sample lsr.config.yaml

Examples:
  lsr add folder --name=notes --path=~/Documents/notes --pattern="**/*.md"
  lsr add papra --name=home --url=http://localhost:8787 --key=KEY
  lsr add himalaya --name=work --mailbox=INBOX --limit=200

Options:
  --config=PATH                     Config file (default: \${DEFAULT_CONFIG_PATH} or $LSR_CONFIG)
Env: LSR_EMBED_MODEL, LSR_EMBED_DTYPE, LSR_DB_PATH, LSR_HOST, LSR_PORT,
     LSR_POLL_INTERVAL, LSR_WEBHOOK_SECRET
`);
}

function flags(args: string[]): Record<string, string> {
	const o: Record<string, string> = {};
	for (const a of args) {
		const m = a.match(/^--([^=]+)=(.*)$/);
		if (m) o[m[1]] = m[2];
	}
	return o;
}

function positions(args: string[]): string[] {
	return args.filter((a) => !a.startsWith("--"));
}

async function main() {
	const args = process.argv.slice(2);
	const cmd = positions(args)[0] ?? "help";
	const rest = args.filter((a) => !a.startsWith("--") && a !== cmd);
	const cfgFile = configPathFromArgs(args);
	const fl = flags(args);
	const registry = await loadDefaultRegistry();

	if (cmd === "help") return usage();
	if (cmd === "env") {
		console.log(EXAMPLE_CONFIG);
		return;
	}

	if (cmd === "plugins") {
		console.log("\nregistered plugins:");
		for (const p of registry.all()) {
			const keys = Object.keys(
				(p.config as { shape?: Record<string, unknown> }).shape ?? {},
			).join(", ");
			console.log(
				`  ${p.id}  — ${p.label}${keys ? `  (config: ${keys})` : ""}`,
			);
		}
		return;
	}

	if (cmd === "add") {
		const pluginId = positions(args)[1];
		if (!pluginId || !registry.has(pluginId)) {
			console.error(
				`unknown plugin "${pluginId ?? ""}". Registered: ${registry
					.all()
					.map((p) => p.id)
					.join(", ")}`,
			);
			process.exit(1);
		}
		try {
			addSource(registry, pluginId, flags(args), cfgFile);
			console.log(`added ${pluginId} source "${fl.name ?? "?"}" -> ${cfgFile}`);
		} catch (e) {
			console.error((e as Error).message);
			process.exit(1);
		}
		return;
	}

	const cfg = loadConfig(registry, cfgFile);
	printConfig(cfg);

	if (cmd === "sources") {
		console.log("\nconfigured sources:");
		for (const s of cfg.sources) {
			const name = s.fields.name;
			const extra = Object.entries(s.fields)
				.filter(([k]) => k !== "name")
				.map(([k]) => `${k}=${JSON.stringify(s.fields[k])}`)
				.join(" ");
			console.log(`  [${s.pluginId}] ${name}${extra ? `  (${extra})` : ""}`);
		}
		return;
	}

	const store = new VectorStore(cfg);
	const { sources, errors } = buildSources(registry, cfg);
	for (const e of errors) console.error(e);

	if (cmd === "status") {
		console.log("\nindex:", store.count());
		store.close();
		return;
	}

	if (cmd === "reindex") {
		await syncAll(cfg, store, sources);
		store.close();
		return;
	}

	if (cmd === "search") {
		const q = rest.join(" ");
		if (!q) {
			console.error('provide a query: lsr search "annual budget report"');
			process.exit(1);
		}
		const k = Number(fl.k ?? 10) || 10;
		const sourceFilter = fl.source ? (fl.source as SourceId) : undefined;
		const results = await query(cfg, store, q, k, sourceFilter);
		for (const r of results) {
			console.log(`\n[${r.score.toFixed(3)}] [${r.source}] ${r.name}`);
			console.log("  ", r.chunk.slice(0, 200));
			console.log("  ", r.url);
		}
		store.close();
		return;
	}

	if (cmd === "serve") {
		await startServer({
			cfg,
			store,
			sources,
			registry,
			stopRef: { current: false },
		});
		return;
	}

	usage();
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
