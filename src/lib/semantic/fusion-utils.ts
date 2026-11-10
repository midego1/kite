/** `"both"` when a message matched both the keyword and the meaning search, otherwise which one it matched. */
export type SemanticMatch = "keyword" | "meaning" | "both";

export type FusedHit = { id: string; score: number; match: SemanticMatch };

/** The constant in `score = Σ 1 / (k + rank)`; keeps either list's own score scale from dominating. */
const RRF_K = 60;

/**
 * Reciprocal rank fusion of two ranked (best-first) id lists: `score = Σ 1 / (RRF_K + rank)` over both lists a message
 * appears in, 1-indexed rank. A message in both lists scores higher than one in just the better-ranked list alone, and
 * ties break by id so the order is deterministic. Pure (`docs/specs/semantic-search.md` section 4.6 step 4).
 */
export function reciprocalRankFusion(keywordIds: readonly string[], meaningIds: readonly string[]): FusedHit[] {
	const scores = new Map<string, number>();
	const inKeyword = new Set(keywordIds);
	const inMeaning = new Set(meaningIds);
	// A ranked list should not repeat an id, but a duplicate counts once, at its first (best) rank.
	const add = (ids: readonly string[]) => {
		const seen = new Set<string>();
		ids.forEach((id, index) => {
			if (seen.has(id)) return;
			seen.add(id);
			scores.set(id, (scores.get(id) ?? 0) + 1 / (RRF_K + index + 1));
		});
	};
	add(keywordIds);
	add(meaningIds);
	return [...scores.entries()]
		.map(([id, score]) => ({
			id,
			score,
			match: (inKeyword.has(id) && inMeaning.has(id)
				? "both"
				: inKeyword.has(id)
					? "keyword"
					: "meaning") as SemanticMatch,
		}))
		.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
}
