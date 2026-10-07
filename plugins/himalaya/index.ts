import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import { parseUpdatedAt, type Ref, type SourceId } from "../../src/domain";
import { definePlugin, nameField } from "../../src/plugin";
import type { Source, SourceItem } from "../../src/types";

const execFileP = promisify(execFile);

const himalayaConfig = z
	.object({
		name: nameField,
		/** himalaya account profile (optional; default account). */
		account: z.string().optional(),
		/** Mailbox to index. */
		mailbox: z.string().default("INBOX"),
		/** Max recent messages to index. */
		limit: z.coerce.number().int().positive().default(200),
		/** himalaya binary path. */
		binary: z.string().optional(),
	})
	.strict();

type HimalayaConfig = z.infer<typeof himalayaConfig>;

/** Treat a value as a plain record, or empty if it isn't one. */
function record(u: unknown): Record<string, unknown> {
	return typeof u === "object" && u !== null && !Array.isArray(u)
		? (u as Record<string, unknown>)
		: {};
}

/** Run himalaya and return parsed JSON stdout. */
async function himalayaJson(
	binary: string,
	args: string[],
	account: string | undefined,
	timeoutMs: number,
): Promise<unknown> {
	const full = [...(account ? ["--account", account] : []), ...args, "--json"];
	const { stdout } = await execFileP(binary, full, {
		timeout: timeoutMs,
		maxBuffer: 64 * 1024 * 1024,
	});
	// himalaya may print log lines to stdout before the JSON; find the JSON payload
	const s = stdout.trim();
	try {
		return JSON.parse(s);
	} catch {
		const start = s.search(/[[{]/);
		if (start < 0)
			throw new Error(`himalaya returned non-JSON output: ${s.slice(0, 200)}`);
		return JSON.parse(s.slice(start));
	}
}

type HEnvelope = {
	id: string;
	subject?: string;
	from?: { name?: string; addr?: string }[];
	date?: string | null;
	message_id?: string | null;
};

function stripHtml(html: string): string {
	return html
		.replace(/<style[\s\S]*?<\/style>/gi, " ")
		.replace(/<script[\s\S]*?<\/script>/gi, " ")
		.replace(/<br\s*\/?>/gi, "\n")
		.replace(/<\/(p|div|li|tr|h[1-6])>/gi, "\n")
		.replace(/<[^>]+>/g, " ")
		.replace(/&nbsp;/g, " ")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/[ \t]+/g, " ")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

class HimalayaSource implements Source {
	readonly id: SourceId;
	readonly label: string;
	private binary: string;
	private account?: string;
	private mailbox: string;
	private limit: number;
	private timeoutMs: number;

	constructor(cfg: HimalayaConfig) {
		this.id = `himalaya:${cfg.name}` as SourceId;
		this.label = `himalaya "${cfg.name}" (${cfg.mailbox})`;
		this.binary = cfg.binary ?? "himalaya";
		this.account = cfg.account || undefined;
		this.mailbox = cfg.mailbox;
		this.limit = cfg.limit;
		this.timeoutMs = 60_000;
	}

	async list(): Promise<SourceItem[]> {
		const out: unknown = await himalayaJson(
			this.binary,
			[
				"envelope",
				"list",
				"--mailbox",
				this.mailbox,
				"--page-size",
				String(this.limit),
			],
			this.account,
			this.timeoutMs,
		);
		const rawEnvelopes = Array.isArray(out) ? out : record(out).envelopes;
		const envelopes: HEnvelope[] = Array.isArray(rawEnvelopes)
			? (rawEnvelopes as HEnvelope[])
			: [];
		return envelopes.map((e) => {
			const sender = e.from?.[0];
			const who = sender?.name || sender?.addr || "";
			return {
				ref: e.id as Ref,
				updatedAt: parseUpdatedAt(e.date),
				name: `${e.subject || "(no subject)"}${who ? ` — ${who}` : ""}`,
				url: sender?.addr ? `mailto:${sender.addr}` : `himalaya:${e.id}`,
			};
		});
	}

	async getContent(ref: Ref): Promise<{ text: string } | null> {
		let out: unknown;
		try {
			out = await himalayaJson(
				this.binary,
				["message", "read", ref, "--mailbox", this.mailbox],
				this.account,
				this.timeoutMs,
			);
		} catch {
			return null;
		}
		const o = record(out);
		const textBody =
			typeof o.text === "string" && o.text.trim() ? o.text.trim() : "";
		const htmlBody =
			typeof o.html === "string" && o.html.trim() ? o.html.trim() : "";
		const body = textBody || (htmlBody ? stripHtml(htmlBody) : "");

		const h = record(o.headers);
		const from = Array.isArray(h.from) ? record(h.from[0]) : record(h.from);
		const fromStr =
			(typeof from.name === "string" ? from.name : "") ||
			(typeof from.addr === "string" ? from.addr : "");
		const subject = typeof h.subject === "string" ? h.subject : "";
		const parts = [
			subject ? `Subject: ${subject}` : "",
			fromStr ? `From: ${fromStr}` : "",
		]
			.filter(Boolean)
			.join("\n");
		const text = [parts, body].filter(Boolean).join("\n\n");
		return text.trim() ? { text } : null;
	}

	onChange(): void {
		// no push mechanism from himalaya; polling is sufficient
	}
}

export default definePlugin<typeof himalayaConfig>({
	id: "himalaya",
	label: "himalaya email",
	description: "Index an email mailbox via the himalaya CLI (JSON mode).",
	config: himalayaConfig,
	createSources(cfg) {
		return [new HimalayaSource(cfg)];
	},
});
