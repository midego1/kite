import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { getDb, type AppDatabase } from "@/db";
import { queryInChunks } from "@/db/chunk-utils";
import { messageBodyKeys } from "@/db/schema/message-bodies";
import { missingColumnFromError } from "@/lib/auth/user-lookup-utils";
import { createLogger } from "@/lib/logger.mjs";
import { htmlBodyObjectKey, isHtmlBodyObjectKey, withoutDerivedText, type HtmlBodyOffload } from "./bodies-utils";

const logger = createLogger("bodies");

/** Object reads in flight per call: a conversation or a JMAP page can hold many offloaded messages. */
const BODY_READ_CONCURRENCY = 8;

const KEY_COLUMN = "html_body_key";

/**
 * `"messages"."html_body_key"`. D1 reads an unknown bare double-quoted name as a string literal, so only the
 * table-qualified name fails, as it must, before migration 0074 (see `src/lib/db/pending-columns.ts`).
 */
const keyColumn = sql<string | null>`${messageBodyKeys}.${sql.identifier(KEY_COLUMN)}`;

type BodyRow = { id: string; htmlBody: string | null; textBody?: string | null };

export type LoadBodiesOptions = {
	/**
	 * The reader reads `textBody || htmlToReadableText(htmlBody)` and nothing else of the HTML, so rows with a text
	 * body need no object read. An offloaded row always keeps one (`planHtmlBodyOffload`), which for a message
	 * without a text part is that same readable text.
	 */
	textFirst?: boolean;
	/**
	 * Throw `MessageBodyUnavailableError` when an object read fails instead of showing the text body, for a reader
	 * whose output is kept (the mbox export). An object that is gone (a restore without the bucket) still shows
	 * the text body, since reading again cannot bring it back.
	 */
	strict?: boolean;
};

/** An offloaded HTML body could not be read from the Mail store; reading again may work. */
export class MessageBodyUnavailableError extends Error {
	constructor(
		readonly messageId: string,
		options?: { cause?: unknown },
	) {
		super("A message body could not be read from the Mail store", options);
		this.name = "MessageBodyUnavailableError";
	}
}

function isMissingKeyColumn(error: unknown): boolean {
	return missingColumnFromError(error) === KEY_COLUMN;
}

/** The ids among `ids` whose HTML body is in the Mail store; none before migration 0074. */
async function offloadedIds(env: CloudflareEnv, ids: string[]): Promise<string[]> {
	const db = getDb(env);
	try {
		const rows = await queryInChunks(ids, (chunk) =>
			db
				.select({ id: messageBodyKeys.id, key: keyColumn })
				.from(messageBodyKeys)
				.where(and(inArray(messageBodyKeys.id, chunk), isNotNull(keyColumn))),
		);
		return rows.filter((row) => isHtmlBodyObjectKey(row.id, row.key)).map((row) => row.id);
	} catch (error) {
		if (isMissingKeyColumn(error)) return [];
		throw error;
	}
}

async function readBody(env: CloudflareEnv, id: string, strict: boolean): Promise<string | null> {
	const key = htmlBodyObjectKey(id);
	try {
		const object = await env.BUCKET.get(key);
		return object ? await object.text() : null;
	} catch (error) {
		logger.warn("bodies.read_failed", { key, error: error instanceof Error ? error.message : String(error) });
		if (strict) throw new MessageBodyUnavailableError(id, { cause: error });
		return null;
	}
}

/** The HTML bodies of `ids` by message id, a few object reads at a time. */
async function readBodies(env: CloudflareEnv, ids: string[], strict: boolean): Promise<Map<string, string>> {
	const html = new Map<string, string>();
	const queue = [...ids];
	const worker = async () => {
		for (let id = queue.shift(); id; id = queue.shift()) {
			const body = await readBody(env, id, strict);
			if (body !== null) html.set(id, body);
		}
	};
	await Promise.all(Array.from({ length: Math.min(BODY_READ_CONCURRENCY, queue.length) }, worker));
	return html;
}

/**
 * The one way to read message bodies: `rows` with `htmlBody` filled in for messages whose HTML was offloaded to
 * the Mail store (imported mail over `BODY_OFFLOAD_BYTES`), and the text body the import derived from that HTML
 * set back to null, so an offloaded message reads exactly like one stored inline. Every other row is returned as
 * it is, and so is an offloaded row whose object is gone (a restore without the bucket), which shows its text.
 */
export async function loadMessageBodies<T extends BodyRow>(
	env: CloudflareEnv,
	rows: T[],
	options: LoadBodiesOptions = {},
): Promise<T[]> {
	const candidates = rows.filter((row) => row.htmlBody === null && !(options.textFirst && row.textBody));
	if (candidates.length === 0) return rows;
	const ids = await offloadedIds(
		env,
		candidates.map((row) => row.id),
	);
	if (ids.length === 0) return rows;
	const html = await readBodies(env, ids, options.strict === true);
	return rows.map((row) => {
		const body = row.htmlBody === null ? html.get(row.id) : undefined;
		return body === undefined ? row : withoutDerivedText({ ...row, htmlBody: body }, body);
	});
}

/** `loadMessageBodies` for one row. */
export async function loadMessageBody<T extends BodyRow>(
	env: CloudflareEnv,
	row: T,
	options: LoadBodiesOptions = {},
): Promise<T> {
	const [loaded] = await loadMessageBodies(env, [row], options);
	return loaded;
}

const offloadReady = new WeakSet<object>();

/**
 * Whether bodies can be offloaded: the database has `html_body_key` (migration 0074). Until then imported HTML
 * stays in the row. A positive answer is kept for the database binding; a negative one is asked again.
 */
export async function canOffloadHtmlBodies(env: CloudflareEnv): Promise<boolean> {
	if (offloadReady.has(env.DB)) return true;
	try {
		await getDb(env).select({ key: keyColumn }).from(messageBodyKeys).limit(0);
		offloadReady.add(env.DB);
		return true;
	} catch (error) {
		if (isMissingKeyColumn(error)) return false;
		throw error;
	}
}

/** Writes an offloaded HTML body to the Mail store. Done before the row exists, so a crash leaves an orphan object. */
export async function putOffloadedHtmlBody(env: CloudflareEnv, offload: HtmlBodyOffload): Promise<void> {
	await env.BUCKET.put(offload.key, offload.html, { httpMetadata: { contentType: "text/html; charset=utf-8" } });
}

/** The statement recording an offloaded body on its row, to run in one batch with the row's insert. */
export function recordOffloadedHtmlBody(db: AppDatabase, messageId: string, offload: HtmlBodyOffload) {
	return db
		.update(messageBodyKeys)
		.set({ htmlBodyKey: offload.key, bodySize: offload.bodySize })
		.where(eq(messageBodyKeys.id, messageId));
}
