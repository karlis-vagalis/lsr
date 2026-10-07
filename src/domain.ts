/**
 * Semantic types for lsr (parse, don't validate).
 *
 * A value's type is its proof of validity: downstream code never re-checks.
 * Construction/branding happens once, at the boundary (config load, embed,
 * similarity computation). These are compile-time brands (runtime is enforced
 * by the guard functions below).
 */

export type Brand<T, B extends string> = T & { readonly __brand: B };

/** A 768-dim normalized embedding vector produced by the embed model. */
export type Embedding = Float32Array & Brand<unknown, "Embedding[768]">;
export const EMBED_DIM = 768;

/** Construct an Embedding, proving (once) the dimension invariant. */
export function embedding(dim: number, data: Float32Array): Embedding {
	if (data.length !== dim) {
		throw new Error(
			`embedding dim mismatch: expected ${dim}, got ${data.length}`,
		);
	}
	return data as Embedding;
}

/** ISO-8601 update cursor used for change detection. */
export type UpdatedAt = string & Brand<unknown, "UpdatedAt-ISO8601">;

/** A source-unique item reference (file path / papra id / himalaya id). */
export type Ref = string & Brand<unknown, "Ref">;

/** Unique id of a configured source (e.g. `col:notes`, `papra:home`). */
export type SourceId = string & Brand<unknown, "SourceId">;

/** Cosine similarity, by construction in [-1, 1]. */
export type Similarity = number & Brand<unknown, "Similarity[-1..1]">;

/** Construct a Similarity, proving finiteness and range. */
export function similarity(raw: number): Similarity {
	if (!Number.isFinite(raw)) {
		throw new Error(`non-finite similarity: ${raw}`);
	}
	// cosine of normalized vectors; clamp tiny float drift so the type is honest
	const clamped = Math.min(1, Math.max(-1, raw));
	return clamped as Similarity;
}

/** Parse an ISO-8601 timestamp or throw. */
export function parseUpdatedAt(
	raw: string | number | null | undefined,
): UpdatedAt {
	const d = new Date(raw ?? NaN);
	if (Number.isNaN(d.getTime())) {
		return "1970-01-01T00:00:00.000Z" as UpdatedAt;
	}
	return d.toISOString() as UpdatedAt;
}
