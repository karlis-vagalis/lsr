import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { parseUpdatedAt, type Ref, type SourceId } from "../../src/domain";
import { definePlugin, nameField, type WebhookContext } from "../../src/plugin";
import type { Source, SourceItem } from "../../src/types";

const papraConfig = z
	.object({
		name: nameField,
		url: z.string().min(1, "url is required"),
		apiKey: z.string().min(1, "apiKey is required"),
		organizationId: z.string().optional(),
		/** Per-source shared secret for webhook signature (optional). */
		webhookSecret: z.string().optional(),
	})
	.strict();

type PapraConfig = z.infer<typeof papraConfig>;

/**
 * Verify a Papra webhook signature (matches packages/webhooks/signature.ts).
 * signature = `v1,<base64 HMAC-SHA256 of "${webhookId}.${timestamp}.${serializedPayload}">`
 * Headers: webhook-id, webhook-timestamp, webhook-signature.
 */
function verifyWebhookSignature(opts: {
	secret: string;
	webhookId: string;
	timestamp: string;
	signature: string;
	rawBody: string;
}): boolean {
	const [version, sigB64] = opts.signature.split(",", 2);
	if (version !== "v1" || !sigB64) return false;
	const payload = `${opts.webhookId}.${opts.timestamp}.${opts.rawBody}`;
	const expected = createHmac("sha256", opts.secret).update(payload).digest();
	let actual: Buffer;
	try {
		actual = Buffer.from(sigB64, "base64");
	} catch {
		return false;
	}
	if (expected.length !== actual.length) return false;
	return timingSafeEqual(expected, actual);
}

type PapraDoc = {
	id: string;
	name: string;
	organizationId: string;
	updatedAt: string;
	content: string;
};

class PapraSource implements Source {
	readonly id: SourceId;
	readonly label: string;
	private orgId: string;

	constructor(private cfg: PapraConfig) {
		this.id = `papra:${cfg.name}` as SourceId;
		this.label = `papra "${cfg.name}"`;
		this.orgId = cfg.organizationId ?? "";
	}

	private async request<T>(path: string): Promise<T> {
		const res = await fetch(`${this.cfg.url}${path}`, {
			headers: {
				Authorization: `Bearer ${this.cfg.apiKey}`,
				"Content-Type": "application/json",
			},
		});
		if (!res.ok) {
			throw new Error(
				`Papra ${this.cfg.name} ${res.status} on GET ${path}: ${(await res.text().catch(() => "")).slice(0, 200)}`,
			);
		}
		return (await res.json()) as T;
	}

	private async listOrgs(): Promise<{ id: string }[]> {
		return (
			await this.request<{ organizations: { id: string }[] }>(
				"/api/organizations",
			)
		).organizations;
	}

	private async resolveOrg(): Promise<string> {
		if (this.orgId) return this.orgId;
		const orgs = await this.listOrgs();
		if (orgs.length !== 1) {
			throw new Error(
				`Papra ${this.cfg.name} has ${orgs.length} orgs; set organizationId in config`,
			);
		}
		this.orgId = orgs[0].id;
		return this.orgId;
	}

	async list(): Promise<SourceItem[]> {
		const org = await this.resolveOrg();
		const docs: PapraDoc[] = [];
		let pageIndex = 0;
		for (;;) {
			const data = await this.request<{
				documents: PapraDoc[];
				documentsCount: number;
			}>(
				`/api/organizations/${org}/documents?pageIndex=${pageIndex}&pageSize=100&sortField=createdAt&sortOrder=desc`,
			);
			docs.push(...data.documents);
			if (docs.length >= data.documentsCount || data.documents.length === 0)
				break;
			pageIndex += 1;
		}
		return docs.map((d) => ({
			ref: d.id as Ref,
			updatedAt: parseUpdatedAt(d.updatedAt),
			name: d.name,
			url: `${this.cfg.url}/documents/${d.id}`,
		}));
	}

	async getContent(ref: Ref): Promise<{ text: string } | null> {
		const org = await this.resolveOrg();
		const data = await this.request<{ document: PapraDoc }>(
			`/api/organizations/${org}/documents/${ref}`,
		);
		const text = (data.document.content ?? "").trim();
		return text ? { text } : null;
	}
}

/** Instances this plugin created, so matchWebhook can map events → sources. */
const instances: { source: PapraSource; secret?: string }[] = [];

export default definePlugin<typeof papraConfig>({
	id: "papra",
	label: "Papra document archive",
	description: "Synchronize one Papra instance's documents via its REST API.",
	config: papraConfig,
	createSources(cfg) {
		const source = new PapraSource(cfg);
		instances.push({ source, secret: cfg.webhookSecret });
		return [source];
	},
	matchWebhook(ctx: WebhookContext): SourceId[] | null {
		const webhookId = ctx.headers.get("webhook-id") ?? "";
		const timestamp = ctx.headers.get("webhook-timestamp") ?? "";
		const signature = ctx.headers.get("webhook-signature") ?? "";
		// a signature is valid for any of our sources that declare the secret,
		// falling back to the core-provided global secret
		const secrets = new Set<string>();
		if (ctx.secret) secrets.add(ctx.secret);
		for (const inst of instances) if (inst.secret) secrets.add(inst.secret);
		let matched = false;
		for (const secret of secrets) {
			if (
				verifyWebhookSignature({
					secret,
					webhookId,
					timestamp,
					signature,
					rawBody: ctx.rawBody,
				})
			) {
				matched = true;
				break;
			}
		}
		if (!matched) return null;
		return instances.map((i) => i.source.id);
	},
});
