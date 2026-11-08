import type { VectorStore } from "./vector-store";
import { groupMailboxIdsForFilter } from "./filter-utils";

/** Vectorize accepts at most this many vectors per `upsert`/`insert` call from a Worker. */
const UPSERT_BATCH_SIZE = 1000;
/** Kept well under Vectorize's per-call id limit for `deleteByIds`. */
const DELETE_BATCH_SIZE = 1000;

function chunks<T>(items: readonly T[], size: number): T[][] {
	const result: T[][] = [];
	for (let index = 0; index < items.length; index += size) result.push(items.slice(index, index + size));
	return result;
}

/**
 * The index `kite-messages` (binding `VECTORIZE`, section 4.3 of the spec): 1,024 dimensions, metric cosine, with a
 * `mailboxId` metadata index. Vectors carry only `mailboxId`; no subject, sender or text. Queries ask for ids only
 * (`returnMetadata: "none"`), which allows `topK` 100.
 */
export class VectorizeStore implements VectorStore {
	constructor(private readonly index: NonNullable<CloudflareEnv["VECTORIZE"]>) {}

	async upsert(items: { id: string; values: Float32Array; mailboxId: string }[]): Promise<void> {
		for (const batch of chunks(items, UPSERT_BATCH_SIZE)) {
			await this.index.upsert(
				batch.map((item) => ({ id: item.id, values: [...item.values], metadata: { mailboxId: item.mailboxId } })),
			);
		}
	}

	async deleteByIds(ids: string[]): Promise<void> {
		for (const batch of chunks(ids, DELETE_BATCH_SIZE)) {
			if (batch.length > 0) await this.index.deleteByIds(batch);
		}
	}

	async query(
		vector: Float32Array,
		options: { mailboxIds: string[]; topK: number },
	): Promise<{ id: string; score: number }[]> {
		const groups = groupMailboxIdsForFilter(options.mailboxIds);
		if (groups.length === 0) return [];
		const values = [...vector];
		const results = await Promise.all(
			groups.map((group) =>
				this.index.query(values, {
					topK: options.topK,
					returnMetadata: "none",
					filter: { mailboxId: { $in: group } },
				}),
			),
		);
		const byId = new Map<string, number>();
		for (const result of results)
			for (const match of result.matches) byId.set(match.id, Math.max(byId.get(match.id) ?? -Infinity, match.score));
		return [...byId.entries()]
			.map(([id, score]) => ({ id, score }))
			.sort((a, b) => b.score - a.score)
			.slice(0, options.topK);
	}
}
