import type { Config } from "./config";
import type { SourceId } from "./domain";
import { query, syncAll } from "./indexer";
import type { PluginRegistry } from "./registry";
import type { VectorStore } from "./store";
import type { SearchHit, Source } from "./types";

export type ServerDeps = {
	cfg: Config;
	store: VectorStore;
	sources: Source[];
	registry: PluginRegistry;
	stopRef: { current: boolean };
};

const ESCAPE: Record<string, string> = {
	"&": "&amp;",
	"<": "&lt;",
	">": "&gt;",
	'"': "&quot;",
	"'": "&#39;",
};
function escapeHtml(s: string): string {
	return s.replace(/[&<>"']/g, (c) => ESCAPE[c] ?? c);
}

function renderHtml(results: SearchHit[], q: string): string {
	const rows = results
		.map(
			(r, i) => `
      <li style="margin:14px 0">
        <div><b>${i + 1}.</b> [${escapeHtml(r.source)}] <a href="${escapeHtml(r.url)}" target="_blank">${escapeHtml(r.name)}</a>
          <span style="color:#888">score ${r.score.toFixed(3)}</span></div>
        <div style="color:#555">${escapeHtml(r.chunk.slice(0, 320))}</div>
      </li>`,
		)
		.join("");
	return `<!doctype html><html><head><meta charset="utf-8"><title>lsr — local search</title></head>
<body style="font-family:sans-serif;max-width:760px;margin:40px auto">
<h1>lsr semantic search</h1>
<form method="get"><input name="q" value="${escapeHtml(q)}" style="width:70%;padding:8px"/>
<button>Search</button></form>
<p style="color:#888">sources: ${results.length ? [...new Set(results.map((r) => r.source))].join(", ") : "—"}</p>
<ul>${rows || "<li><i>no results</i></li>"}</ul>
</body></html>`;
}

/**
 * Handle an inbound webhook by asking every plugin whether it owns the event
 * (e.g. Papra verifies its HMAC signature). Matched events nudge a re-sync.
 * Core stays protocol-agnostic; each plugin authenticates its own events.
 */
async function handleWebhook(
	deps: ServerDeps,
	req: Request,
): Promise<Response> {
	if (req.method !== "POST")
		return new Response("method not allowed", { status: 405 });
	const rawBody = await req.text();
	let body: unknown;
	try {
		body = JSON.parse(rawBody);
	} catch {
		body = undefined;
	}
	const ctx = {
		body,
		rawBody,
		headers: req.headers,
		secret: deps.cfg.search.webhookSecret || undefined,
	};
	let matched = false;
	for (const plugin of deps.registry.all()) {
		const ids = plugin.matchWebhook?.(ctx) ?? [];
		if (ids.length > 0) matched = true;
	}
	if (!matched) return new Response("unrecognized event", { status: 400 });
	syncAll(deps.cfg, deps.store, deps.sources).catch((e) =>
		console.error("[webhook] sync failed:", e),
	);
	return new Response("ok", { status: 200 });
}

export async function startServer(deps: ServerDeps): Promise<void> {
	const { cfg, store, sources } = deps;

	const server = Bun.serve({
		hostname: cfg.search.host,
		port: cfg.search.port,
		async fetch(req) {
			const url = new URL(req.url);
			const path = url.pathname;

			if (path === "/health" || path === "/") {
				return Response.json({ ok: true, ...store.count() });
			}

			if (path === "/search") {
				const q = url.searchParams.get("q") ?? "";
				const k = Math.min(Number(url.searchParams.get("k") ?? 10) || 10, 50);
				const source = url.searchParams.get("source") ?? undefined;
				if (!q) return Response.json({ error: "missing ?q=" }, { status: 400 });
				const results = await query(
					cfg,
					store,
					q,
					k,
					source ? (source as SourceId) : undefined,
				);
				if ((req.headers.get("accept") ?? "").includes("text/html")) {
					return new Response(renderHtml(results, q), {
						headers: { "content-type": "text/html" },
					});
				}
				return Response.json({ query: q, source: source ?? null, results });
			}

			if (path === "/webhook") {
				return handleWebhook(deps, req);
			}

			return new Response("not found", { status: 404 });
		},
	});

	console.log(`[http] ${cfg.search.host}:${cfg.search.port}`);

	const loop = async () => {
		try {
			await syncAll(cfg, store, sources);
		} catch (err) {
			console.error("[poll]", (err as Error).message);
		}
	};
	await loop();
	const timer = setInterval(loop, cfg.search.pollIntervalSec * 1000);

	const stop = () => {
		deps.stopRef.current = true;
		clearInterval(timer);
		server.stop();
		store.close();
		process.exit(0);
	};
	process.on("SIGINT", stop);
	process.on("SIGTERM", stop);
}
