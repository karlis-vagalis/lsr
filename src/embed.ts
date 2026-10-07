import {
	type FeatureExtractionPipeline,
	pipeline,
} from "@huggingface/transformers";
import type { Config } from "./config";
import { EMBED_DIM, type Embedding, embedding } from "./domain";

let _pipe: FeatureExtractionPipeline | null = null;
let _model = "";
let _dtype = "";

/** Load (once) the feature-extraction pipeline. */
export async function getExtractor(
	cfg: Config,
): Promise<FeatureExtractionPipeline> {
	if (_pipe && _model === cfg.search.model && _dtype === cfg.search.dtype)
		return _pipe;
	_pipe = (await pipeline("feature-extraction", cfg.search.model, {
		dtype: cfg.search.dtype,
		device: "cpu",
	})) as FeatureExtractionPipeline;
	_model = cfg.search.model;
	_dtype = cfg.search.dtype;
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

/** Embed texts -> [n, 768] Embedding rows (dimension checked at construction). */
export async function embedTexts(
	cfg: Config,
	texts: string[],
): Promise<Embedding[]> {
	if (texts.length === 0) return [];
	const pipe = await getExtractor(cfg);
	const out = await pipe(texts, { pooling: "mean", normalize: true });
	const dims = out.dims as unknown as number[];
	const dim = dims[dims.length - 1] ?? EMBED_DIM;
	const data = out.data as unknown as Float32Array;
	const rows: Embedding[] = [];
	for (let i = 0; i < texts.length; i++) {
		rows.push(embedding(dim, data.subarray(i * dim, (i + 1) * dim).slice()));
	}
	return rows;
}
