import Database from "better-sqlite3";
import type { VectorStore } from "../../src/lib/semantic/vector-store";

/** Rows are read in pages this large, each scored and folded into a running top-K, so a search never materialises the whole table. */
const PAGE_SIZE = 5000;
/** SQLite's own bound-parameter ceiling is 999 by default; this keeps one `IN (...)` well under it either way. */
const MAILBOX_IDS_PER_QUERY = 200;

function chunks<T>(items: readonly T[], size: number): T[][] {
	const result: T[][] = [];
	for (let index = 0; index < items.length; index += size) result.push(items.slice(index, index + size));
	return result;
}

/** int8 quantisation with one scale factor per vector: `round(value / scale)`, clamped to the int8 range. */
function quantize(values: Float32Array): { scale: number; data: Buffer } {
	let max = 0;
	for (const value of values) max = Math.max(max, Math.abs(value));
	const scale = max > 0 ? max / 127 : 1;
	const data = Buffer.alloc(values.length);
	for (let index = 0; index < values.length; index++) {
		const quantized = Math.round(values[index] / scale);
		data[index] = quantized < -128 ? -128 : quantized > 127 ? 127 : quantized < 0 ? quantized + 256 : quantized;
	}
	return { scale, data };
}

function dequantize(scale: number, data: Buffer): Float32Array {
	const values = new Float32Array(data.length);
	for (let index = 0; index < data.length; index++) {
		const byte = data[index];
		values[index] = (byte > 127 ? byte - 256 : byte) * scale;
	}
	return values;
}

function dot(a: Float32Array, b: Float32Array): number {
	let sum = 0;
	for (let index = 0; index < a.length; index++) sum += a[index] * b[index];
	return sum;
}

function norm(values: Float32Array): number {
	return Math.sqrt(dot(values, values));
}

/**
 * The Node/self-hosted vector store (`docs/specs/semantic-search.md` section 4.3): brute force over a separate
 * SQLite file, never the main database, so its backups and the D1 schema stay untouched. `query` scans pages of
 * `PAGE_SIZE` rows and keeps a running top-K by cosine similarity on dequantised int8 vectors. Exact (no ANN index);
 * fast enough for the mailbox sizes a self-hosted install runs (decision 14 picks this over sqlite-vec unless
 * measurements show a need).
 */
export class SqliteVectorStore implements VectorStore {
	private readonly db: Database.Database;

	constructor(filename: string) {
		this.db = new Database(filename);
		this.db.pragma("journal_mode = WAL");
		this.db.exec(
			"CREATE TABLE IF NOT EXISTS vectors (id TEXT PRIMARY KEY, mailbox_id TEXT, scale REAL NOT NULL, data BLOB NOT NULL)",
		);
		this.db.exec("CREATE INDEX IF NOT EXISTS vectors_mailbox_idx ON vectors (mailbox_id)");
	}

	async upsert(items: { id: string; values: Float32Array; mailboxId: string }[]): Promise<void> {
		const statement = this.db.prepare(
			"INSERT INTO vectors (id, mailbox_id, scale, data) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET mailbox_id = excluded.mailbox_id, scale = excluded.scale, data = excluded.data",
		);
		this.db.transaction(() => {
			for (const item of items) {
				const { scale, data } = quantize(item.values);
				statement.run(item.id, item.mailboxId, scale, data);
			}
		})();
	}

	async deleteByIds(ids: string[]): Promise<void> {
		if (ids.length === 0) return;
		const statement = this.db.prepare("DELETE FROM vectors WHERE id = ?");
		this.db.transaction(() => {
			for (const id of ids) statement.run(id);
		})();
	}

	async listIds(cursor: number): Promise<{ ids: string[]; cursor: number | null }> {
		const rows = this.db
			.prepare("SELECT rowid as cursor, id FROM vectors WHERE rowid > ? ORDER BY rowid LIMIT ?")
			.all(cursor, PAGE_SIZE) as { cursor: number; id: string }[];
		if (rows.length === 0) return { ids: [], cursor: null };
		return { ids: rows.map((row) => row.id), cursor: rows.length < PAGE_SIZE ? null : rows[rows.length - 1].cursor };
	}

	async query(
		vector: Float32Array,
		options: { mailboxIds: string[]; topK: number },
	): Promise<{ id: string; score: number }[]> {
		const mailboxIds = [...new Set(options.mailboxIds)];
		if (mailboxIds.length === 0 || options.topK <= 0) return [];
		const queryNorm = norm(vector);
		const top: { id: string; score: number }[] = [];
		const insert = (id: string, score: number) => {
			if (top.length < options.topK) {
				top.push({ id, score });
				top.sort((a, b) => a.score - b.score);
			} else if (score > top[0].score) {
				top[0] = { id, score };
				top.sort((a, b) => a.score - b.score);
			}
		};
		for (const group of chunks(mailboxIds, MAILBOX_IDS_PER_QUERY)) {
			const placeholders = group.map(() => "?").join(", ");
			const statement = this.db.prepare(
				`SELECT rowid as cursor, id, scale, data FROM vectors WHERE mailbox_id IN (${placeholders}) AND rowid > ? ORDER BY rowid LIMIT ?`,
			);
			let cursor = 0;
			for (;;) {
				const rows = statement.all(...group, cursor, PAGE_SIZE) as {
					cursor: number;
					id: string;
					scale: number;
					data: Buffer;
				}[];
				if (rows.length === 0) break;
				for (const row of rows) {
					const values = dequantize(row.scale, row.data);
					const rowNorm = norm(values);
					if (rowNorm > 0 && queryNorm > 0) insert(row.id, dot(vector, values) / (queryNorm * rowNorm));
				}
				cursor = rows[rows.length - 1].cursor;
				if (rows.length < PAGE_SIZE) break;
			}
		}
		return top.sort((a, b) => b.score - a.score);
	}

	close(): void {
		this.db.close();
	}
}
