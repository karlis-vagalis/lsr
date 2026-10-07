import {
	type FeatureExtractionPipeline,
	pipeline,
} from "@huggingface/transformers";
import type { Config } from "./config";
import { EMBED_DIM, type Embedding, embedding } from "./domain";

let _pipe: FeatureExtractionPipeline | null = null;
let _model = "";
let _dtype = "";

/** Max texts per forward pass — keeps ONNX memory flat on large docs. */
const EMBED_BATCH = 8;

/** Load (once) the feature-extraction pipeline. */
export async function getExtractor(
	cfg: Config,
): Promise<FeatureExtractionPipeline> {
	if (_pipe && _model === cfg.search.model && _dtype === cfg.search.dtype)
		return _pipe;
	console.log(`model: preparing ${cfg.search.model} (${cfg.search.dtype})…`);
	try {
		_pipe = (await pipeline("feature-extraction", cfg.search.model, {
			dtype: cfg.search.dtype,
			device: "cpu",
		})) as FeatureExtractionPipeline;
	} catch (err) {
		console.error("model: failed to load", (err as Error).message);
		throw err;
	}
	_model = cfg.search.model;
	_dtype = cfg.search.dtype;
	console.log("model: ready (768-dim, CPU)");
	return _pipe;
}

/** Split text into overlapping character-based chunks. */
export function chunkText(
	text: string,
	maxChars: number,
	overlap: number,
): string[] {
	const clean = text.replace(/\s+/g, " ").trim();
	if (!clean) return [];
	if (clean.length <= maxChars) return [clean];
	const chunks: string[] = [];
	let start = 0;
	while (start < clean.length) {
		let end = Math.min(start + maxChars, clean.length);
		if (end < clean.length) {
			const nl = clean.lastIndexOf(" ", end);
			if (nl > start) end = nl;
		}
		const piece = clean.slice(start, end).trim();
		if (piece) chunks.push(piece);
		if (end >= clean.length) break;
		start = Math.max(start + 1, end - overlap);
	}
	return chunks;
}

/** Embed texts -> [n, 768] Embedding rows (dimension checked at construction).
 *  Runs in EMBED_BATCH-sized sub-batches so a huge doc can't spike RAM. */
export async function embedTexts(
	cfg: Config,
	texts: string[],
): Promise<Embedding[]> {
	if (texts.length === 0) return [];
	const pipe = await getExtractor(cfg);
	const rows: Embedding[] = [];
	for (let start = 0; start < texts.length; start += EMBED_BATCH) {
		const batch = texts.slice(start, start + EMBED_BATCH);
		const out = await pipe(batch, { pooling: "mean", normalize: true });
		const dims = out.dims as unknown as number[];
		const dim = dims[dims.length - 1] ?? EMBED_DIM;
		const data = out.data as unknown as Float32Array;
		for (let i = 0; i < batch.length; i++) {
			rows.push(embedding(dim, data.subarray(i * dim, (i + 1) * dim).slice()));
		}
	}
	return rows;
}
