import { createLogger } from "../../src/lib/logger.mjs";

import type Database from "better-sqlite3";
import { describeQueueMessage } from "../../worker-utils";
import { getQueueRetryDelayMs, getQueueWakeDelayMs, shouldRetryQueueMessage } from "./queue-utils";

const logger = createLogger("node-queue");

/**
 * The Queue producer API with an in-process consumer. Messages are stored in
 * the `node_queue_messages` table of the app database until the consumer
 * succeeds, so delayed sends (undo-send holds, scheduled mail, webhook
 * retries) and unprocessed inbound mail survive a restart. Delivery is
 * at-least-once like Cloudflare Queues: a message that was mid-delivery when
 * the process stopped runs again on the next start. The retry policy matches
 * wrangler.jsonc (three retries, ten seconds apart).
 */
export type QueueConsumer = (body: unknown) => Promise<void>;

type QueueRow = { id: number; body: string; attempts: number; available_at: number };

const MAX_CONCURRENT_DELIVERIES = 5;

export function ensureQueueTable(db: Database.Database) {
	db.exec(`
		CREATE TABLE IF NOT EXISTS node_queue_messages (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			queue TEXT NOT NULL,
			body TEXT NOT NULL,
			attempts INTEGER NOT NULL DEFAULT 0,
			available_at INTEGER NOT NULL,
			created_at INTEGER NOT NULL
		);
		CREATE INDEX IF NOT EXISTS node_queue_messages_due_idx ON node_queue_messages (queue, available_at);
	`);
}

/** Re-files messages stored under an earlier queue name so a rename keeps pending work. */
export function adoptQueueMessages(db: Database.Database, fromName: string, toName: string) {
	ensureQueueTable(db);
	db.prepare("UPDATE node_queue_messages SET queue = ? WHERE queue = ?").run(toName, fromName);
}

export class InProcessQueue {
	private consumer: QueueConsumer | null = null;
	private readonly maxRetries: number;
	private readonly retryDelayMs: number;
	private readonly now: () => number;
	private readonly inFlight = new Set<number>();
	private timer: ReturnType<typeof setTimeout> | null = null;
	private stopped = false;

	constructor(
		readonly name: string,
		private readonly db: Database.Database,
		options?: { maxRetries?: number; retryDelayMs?: number; now?: () => number },
	) {
		this.maxRetries = options?.maxRetries ?? 3;
		this.retryDelayMs = options?.retryDelayMs ?? getQueueRetryDelayMs();
		this.now = options?.now ?? Date.now;
		ensureQueueTable(db);
	}

	setConsumer(consumer: QueueConsumer) {
		this.consumer = consumer;
		this.stopped = false;
		this.wake();
	}

	async send(body: unknown, options?: { delaySeconds?: number }) {
		const now = this.now();
		this.db
			.prepare(
				"INSERT INTO node_queue_messages (queue, body, attempts, available_at, created_at) VALUES (?, ?, 0, ?, ?)",
			)
			.run(this.name, JSON.stringify(body ?? null), now + Math.max(0, options?.delaySeconds ?? 0) * 1000, now);
		this.wake();
	}

	async sendBatch(messages: Iterable<{ body: unknown; delaySeconds?: number }>) {
		for (const message of messages) await this.send(message.body, { delaySeconds: message.delaySeconds });
	}

	async metrics() {
		const row = this.db.prepare("SELECT COUNT(*) AS count FROM node_queue_messages WHERE queue = ?").get(this.name) as {
			count: number;
		};
		return { backlogCount: row.count };
	}

	/** Resolves once nothing is due or running; delayed messages stay stored. */
	async drain(): Promise<void> {
		while (this.inFlight.size > 0 || this.dueRows(1).length > 0) await new Promise((resolve) => setTimeout(resolve, 5));
	}

	private dueRows(limit: number): QueueRow[] {
		const exclude = [...this.inFlight];
		const placeholders = exclude.map(() => "?").join(", ");
		return this.db
			.prepare(
				`SELECT id, body, attempts, available_at FROM node_queue_messages WHERE queue = ? AND available_at <= ?${exclude.length ? ` AND id NOT IN (${placeholders})` : ""} ORDER BY available_at, id LIMIT ?`,
			)
			.all(this.name, this.now(), ...exclude, limit) as QueueRow[];
	}

	private wake() {
		if (this.stopped || !this.consumer) return;
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = null;
		}
		const capacity = MAX_CONCURRENT_DELIVERIES - this.inFlight.size;
		if (capacity > 0) {
			for (const row of this.dueRows(capacity)) void this.deliver(row);
		}
		if (this.inFlight.size >= MAX_CONCURRENT_DELIVERIES) return;
		const next = this.db
			.prepare("SELECT MIN(available_at) AS at FROM node_queue_messages WHERE queue = ? AND available_at > ?")
			.get(this.name, this.now()) as { at: number | null };
		const delay = getQueueWakeDelayMs(next.at, this.now());
		if (delay === null) return;
		this.timer = setTimeout(() => {
			this.timer = null;
			this.wake();
		}, delay);
		this.timer.unref?.();
	}

	private async deliver(row: QueueRow) {
		if (this.inFlight.has(row.id)) return;
		this.inFlight.add(row.id);
		try {
			let body: unknown;
			try {
				body = JSON.parse(row.body);
			} catch {
				logger.error("queue.unreadable_message", { queue: this.name, messageId: row.id });
				this.remove(row.id);
				return;
			}
			try {
				await this.consumer?.(body);
				this.remove(row.id);
			} catch (error) {
				const context = { queue: this.name, messageId: row.id, attempts: row.attempts, ...describeQueueMessage(body) };
				logger.error("queue.job_failed", { ...context, error });
				if (shouldRetryQueueMessage(row.attempts, this.maxRetries)) {
					this.db
						.prepare("UPDATE node_queue_messages SET attempts = attempts + 1, available_at = ? WHERE id = ?")
						.run(this.now() + this.retryDelayMs, row.id);
				} else {
					logger.error("queue.retries_exhausted", { ...context, maxRetries: this.maxRetries });
					this.remove(row.id);
				}
			}
		} finally {
			this.inFlight.delete(row.id);
			queueMicrotask(() => this.wake());
		}
	}

	private remove(id: number) {
		this.db.prepare("DELETE FROM node_queue_messages WHERE id = ?").run(id);
	}

	stop() {
		this.stopped = true;
		if (this.timer) clearTimeout(this.timer);
		this.timer = null;
	}
}

export function openQueue<T>(name: string, db: Database.Database): Queue<T> & InProcessQueue {
	return new InProcessQueue(name, db) as unknown as Queue<T> & InProcessQueue;
}
