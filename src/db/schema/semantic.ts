import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * Search by meaning (migration 0099, `docs/specs/semantic-search.md`): one row per message tracking its embedding
 * state. No foreign key to `messages` so the `AFTER DELETE` trigger can still read the row it is about to remove.
 * `vectorKey` is filled in by `src/lib/semantic/indexer.ts` the first time a row is claimed (the first 32 hex
 * characters of SHA-256 of the message id) rather than by the trigger that inserts the row, because SQLite/D1 has no
 * built-in SHA-256 function; a message deleted before that leaves a tombstone with nothing to remove. Derived from
 * `messages` and rebuilt by the triggers, so it is internal (not backed up).
 */
export const messageEmbeddings = sqliteTable(
	"message_embeddings",
	{
		messageId: text("message_id").primaryKey(),
		mailboxId: text("mailbox_id"),
		vectorKey: text("vector_key"),
		status: text("status", { enum: ["pending", "running", "indexed", "skipped", "failed"] })
			.notNull()
			.default("pending"),
		chunkCount: integer("chunk_count").notNull().default(0),
		/** SHA-256 of the embedded text and model; skips re-embedding unchanged content on a rebuild. */
		contentHash: text("content_hash"),
		model: text("model"),
		attempts: integer("attempts").notNull().default(0),
		/** A code, never content. */
		error: text("error"),
		leaseUntil: integer("lease_until", { mode: "timestamp" }),
		queuedAt: integer("queued_at", { mode: "timestamp" }),
		indexedAt: integer("indexed_at", { mode: "timestamp" }),
	},
	(t) => [
		index("message_embeddings_status_queued_idx").on(t.status, t.queuedAt),
		index("message_embeddings_mailbox_idx").on(t.mailboxId),
		index("message_embeddings_vector_key_idx").on(t.vectorKey),
	],
);

/**
 * Tombstones of deleted messages, drained by `processEmbeddingBatch` with `deleteByIds`. `id` is `AUTOINCREMENT`
 * (review round 3, S-A): a plain rowid is reused once the table empties, which let a tombstone from a brand-new
 * delete land in the same id an overlapping drain was already about to delete, dropping it undrained and leaking
 * its vectors. Internal, like `message_embeddings`.
 */
export const messageEmbeddingDeletes = sqliteTable(
	"message_embedding_deletes",
	{
		id: integer("id").primaryKey({ autoIncrement: true }),
		vectorKey: text("vector_key"),
		chunkCount: integer("chunk_count").notNull().default(0),
		createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
	},
	(t) => [index("message_embedding_deletes_created_idx").on(t.createdAt)],
);
