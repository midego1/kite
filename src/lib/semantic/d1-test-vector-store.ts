import type { VectorStore } from "./vector-store";

/**
 * The dev/e2e vector store (`docs/specs/semantic-search.md` section 11): brute force over a table created at
 * runtime in the same D1 database, used only when `SEMANTIC_TEST_STORE=1` and `NODE_ENV !== "production"` (the
 * `vite.config.ts` customizer injects it as `env.VECTORS` for `npm run dev`; `playwright.config.ts` sets the env
 * var). `wrangler dev` has no local Vectorize emulation without remote access, so specs cannot use the real binding.
 * Test-scale only: it loads every candidate row per query rather than paging, unlike the Node store.
 */
export class D1TestVectorStore implements VectorStore {
	private ready: Promise<void> | null = null;

	constructor(private readonly db: Pick<CloudflareEnv, "DB">["DB"]) {}

	private async ensureTable(): Promise<void> {
		this.ready ??= this.db
			.prepare(
				"CREATE TABLE IF NOT EXISTS semantic_test_vectors (id TEXT PRIMARY KEY, mailbox_id TEXT, values_json TEXT NOT NULL)",
			)
			.run()
			.then(() => undefined);
		await this.ready;
	}

	async upsert(items: { id: string; values: Float32Array; mailboxId: string }[]): Promise<void> {
		await this.ensureTable();
		for (const item of items) {
			await this.db
				.prepare(
					"INSERT INTO semantic_test_vectors (id, mailbox_id, values_json) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET mailbox_id = excluded.mailbox_id, values_json = excluded.values_json",
				)
				.bind(item.id, item.mailboxId, JSON.stringify([...item.values]))
				.run();
		}
	}

	async deleteByIds(ids: string[]): Promise<void> {
		await this.ensureTable();
		for (const id of ids) await this.db.prepare("DELETE FROM semantic_test_vectors WHERE id = ?").bind(id).run();
	}

	async listIds(cursor: number): Promise<{ ids: string[]; cursor: number | null }> {
		await this.ensureTable();
		const pageSize = 1_000;
		const { results } = await this.db
			.prepare("SELECT rowid AS cursor, id FROM semantic_test_vectors WHERE rowid > ? ORDER BY rowid LIMIT ?")
			.bind(cursor, pageSize)
			.all<{ cursor: number; id: string }>();
		if (results.length === 0) return { ids: [], cursor: null };
		return {
			ids: results.map((row) => row.id),
			cursor: results.length < pageSize ? null : results[results.length - 1].cursor,
		};
	}

	async query(
		vector: Float32Array,
		options: { mailboxIds: string[]; topK: number },
	): Promise<{ id: string; score: number }[]> {
		await this.ensureTable();
		const mailboxIds = [...new Set(options.mailboxIds)];
		if (mailboxIds.length === 0 || options.topK <= 0) return [];
		const placeholders = mailboxIds.map(() => "?").join(", ");
		const { results } = await this.db
			.prepare(`SELECT id, values_json FROM semantic_test_vectors WHERE mailbox_id IN (${placeholders})`)
			.bind(...mailboxIds)
			.all<{ id: string; values_json: string }>();
		const queryNorm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
		const scored = results.map((row) => {
			const values: number[] = JSON.parse(row.values_json);
			let dot = 0;
			let normSquared = 0;
			for (let index = 0; index < values.length; index++) {
				dot += (vector[index] ?? 0) * values[index];
				normSquared += values[index] * values[index];
			}
			const rowNorm = Math.sqrt(normSquared);
			const score = rowNorm > 0 && queryNorm > 0 ? dot / (queryNorm * rowNorm) : 0;
			return { id: row.id, score };
		});
		return scored.sort((a, b) => b.score - a.score).slice(0, options.topK);
	}
}
