# lsr — local semantic search (plugin sources)

`lsr` is a single CLI + HTTP daemon that runs **local, on-device semantic search** over three
kinds of sources, all embedded with the same model (EmbeddingGemma 2 via `@huggingface/transformers`,
ONNX, no llama.cpp, no API):

- **collections** — local folders/files selected with a glob pattern (qmd-style)
- **papra** — one or more Papra document archives, polled via their REST API
- **himalaya** — email accounts/mailboxes via the himalaya CLI (JSON mode)

Everything is indexed into one local SQLite file and queried through one interface, and
sources are contributed by **plugins** (see `plugins/`) loaded by a single registry.

```
File collection ─┐
(poll fs / glob) │   ┌─────────────────────────────┐
                 ├──▶│   lsr core                  │
Papra instance ──┘   │  embed (EmbeddingGemma 2)   │──▶ CLI search
(webhook/poll)  ──▶  │  sqlite vector store        │    HTTP /search /health /webhook
himalaya email ──▶   └─────────────────────────────┘
(poll CLI: --json)
```

## Install

Requires [Bun](https://bun.sh) >= 1.1.

```bash
# from the repo
bun link                 # makes `lsr` available globally (dev)

# or once published
npm i -g @karlis-vagalis/lsr
```

Then use the `lsr` command directly (`lsr --help`).

## Setup

```bash
lsr env                       # print a sample config
cp <sample> lsr.config.yaml   # then edit
```

A `lsr.config.yaml` looks like. Any configured source names the plugin that built it;
the plugin's own Zod schema validates its fields:

```yaml
sources:
  - plugin: folder
    name: notes
    path: ~/Documents/notes
    pattern: "**/*.md"
  - plugin: folder
    name: archive
    path: ~/Documents
    pattern: "**/*.{md,txt,log}"
  - plugin: papra
    name: home
    url: http://localhost:8787
    apiKey: <papra-api-key>       # needs documents:read
    # organizationId: (optional; auto-detected when one org)
    # webhookSecret: ...          # per-source signature secret (optional)
  - plugin: himalaya
    name: work
    # account: work   # himalaya account profile (default account)
    # mailbox: INBOX  # mailbox to index
    # limit: 200      # max recent messages
search:
  model: onnx-community/embeddinggemma-2-ONNX
  dtype: q4                       # q4 | q8 | fp16 | fp32
  dbPath: ./lsr.sqlite
  port: 4747
  pollInterval: 60
  # webhookSecret: ...            # shared fallback signature secret for plugins
```

Or build it up with the CLI (writes/updates the YAML):

```bash
lsr add folder --name=notes --path=~/Documents/notes --pattern="**/*.md"
lsr add papra --name=home --url=http://localhost:8787 --api-key=<key>
lsr add himalaya --name=work --mailbox=INBOX --limit=200
lsr plugins       # see every registered plugin + its config schema
```

**Prereqs:** Bun; Papra API key (`documents:read`) if you index Papra; the **himalaya CLI**
(`cargo install himalaya` or release binary) with an account configured via the `himalaya`
wizard, if you index email.

## Usage

```bash
lsr serve                                  # daemon: poll + HTTP :4747 (+ webhook)
lsr reindex                                # one full sync pass, then exit
lsr search "annual budget report"          # top-10 across all sources
lsr search "docker error" --source=papra:home   # filter by source
lsr search "meeting follow-up" --source=himalaya:work
lsr search "bake bread" --k=3
lsr status                                 # per-source index stats
lsr sources                                # list configured sources
lsr plugins                                # list registered plugins
lsr version
```

Every command accepts `--config=PATH` (short: `-c`) or `$LSR_CONFIG` for multiple
configs/instances. **Cmd options go after the command**: `lsr search "q" --config=…`
(citty-style).

## HTTP API (localhost)

| Route | Description |
|---|---|
| `GET /health` | `{ ok, bySource, chunks }` |
| `GET /search?q=...&k=10` | JSON results (`url` links back to the file or Papra doc) |
| `GET /search?q=...` `Accept: text/html` | human-readable page |
| `POST /webhook` | authenticated events; each plugin decides ownership + signature |

Note: URL-encode query values (`?q=hello%20world`).

## Architecture

```
src/
  cli.ts        serve | reindex | search | status | sources | plugins | add | service | env
  config.ts     lsr.config.yaml parser (Zod + plugin schema-driven) + `add`
  domain.ts     semantic types (Embedding[768], UpdatedAt, Ref, SourceId, Similarity)
  plugin.ts     source-plugin SDK (Zod config schema + createSources + matchWebhook)
  registry.ts   PluginRegistry — loads plugins/*/index.ts, registers all by default
  service.ts    systemd unit generation + install/uninstall/status
  types.ts      Source interface + registry-driven buildSources()
  store.ts      multi-source sqlite vector store (brute-force cosine)
  embed.ts      EmbeddingGemma 2 via @huggingface/transformers (returns Embedding[768])
  indexer.ts    per-source diff/reindex + cross-source query
  server.ts     HTTP server + poll loop + generic webhook dispatch
plugins/
  folder/index.ts
  papra/index.ts
  himalaya/index.ts
```

### The `Source` interface
Core is plugin-agnostic: everything a source exposes is `list` + `getContent`:

```ts
interface Source {
  id: SourceId;                          // branded, e.g. "folder:notes", "papra:home"
  list(): Promise<SourceItem[]>;         // [{ ref: Ref, updatedAt: UpdatedAt, name, url }]
  getContent(ref: Ref): Promise<{ text: string } | null>;
  onChange?(cb: () => void): void;       // optional push nudge (webhook / fs.watch)
}
```

### Writing a plugin
A plugin is just a module at `plugins/<id>/index.ts` exporting a `SourcePlugin`:

```ts
// plugins/mything/index.ts
import { z } from "zod";
import { definePlugin, nameField } from "../../src/plugin";
import type { Source, SourceItem } from "../../src/types";

const myConfig = z.object({ name: nameField, baseUrl: z.string().min(1) }).strict();

export default definePlugin<typeof myConfig>({
  id: "mything",
  label: "My thing",
  config: myConfig,                       // drives validation + `lsr add` + `plugins`
  createSources(cfg) { return [new MySource(cfg)]; },
  matchWebhook(ctx) { /* verify + return source ids to nudge, or null */ },
});
```

- The registry scans `plugins/*/index.ts` at startup and registers every plugin **by
  default** — no core edits needed to add a source type.
- The plugin owns its **config schema** (Zod, use `.strict()` to reject unknown keys) and
  its **events** (`matchWebhook` handles authentication/signature and returns which
  sources to nudge). Core just validates via the schema, calls `createSources`, and treats
  the resulting `Source[]` uniformly.
- Config, CLI `add`, and the HTTP webhook all go through the plugin SDK — a plugin is
  registered once and everything else follows.

### Validation: Zod schemas + domain brands
Two layers keep illegal states unrepresentable:

- **Zod schemas** validate everything that crosses in from the outside — the config file
  (`sources` entries validated against each plugin's schema, `search` against an enum/
  coerce schema) and CLI `add` flags — and give precise errors (`Unrecognized key: "bogus"`,
  `name: name is required`). TS types are derived with `z.infer`.
- **Domain brands** in `domain.ts` make *internal* illegal states unrepresentable:
  - `Embedding[768]` — the store only ever accepts/returns 768-dim vectors; `embedding()`
    checks the dimension at construction (kills the bytes-vs-elements bug class).
  - `UpdatedAt` / `Ref` / `SourceId` — distinct types so a change-cursor can't be confused
    with an arbitrary string, and source ids can't be mixed with item refs.
  - `Similarity[-1..1]` — `similarity()` proves finiteness + range once.

These are compile-time brands backed by guard constructors — see `domain.ts`.

### Notes / current scope
- **Text only, for now.** `getContent` returns text; folder sources skip binary files.
  The model is multimodal, but image/audio embedding is a future milestone (a `bytes`
  path can be added to `SourceItem` without reworking the core).
- **Storage** is brute-force cosine over float32 blobs — sub-ms up to tens of thousands of
  chunks. Swap `store.search` for sqlite-vec only if a source grows very large.
- Change detection: polling (default 60s, idempotent) is the base; Papra webhooks add
  near-instant nudges when `webhookSecret` is configured. `fs.watch` for folders is a
  planned enhancement (polling is reliable and cross-platform).
- Model cached under `~/.cache/huggingface` (~174 MB at q4, first run only).

## Run as a service (systemd)

Install, start and auto-enable the daemon (a user unit by default):

```bash
lsr service install --config=/absolute/path/to/lsr.config.yaml   # --system for root
lsr service status              # inspect
lsr service uninstall           # stop + remove
```

It writes a hardened unit (`ExecStart=<bun> <entry> serve` with `LSR_CONFIG` set,
`NoNewPrivileges`, `PrivateTmp`, `ProtectSystem`) and runs `systemctl --user daemon-reload`
+ `enable --now`. Logs: `journalctl --user -u lsr -f`. To run as root add `--system`
(requires sudo). See `examples/lsr.service` for a hand-edited template.

## License
MIT (this tool). It talks only to Papra's public REST/webhook API and does not modify or
redistribute Papra.
