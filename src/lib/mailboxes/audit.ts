import { getDb } from "@/db";
import { auditLogs } from "@/db/schema";
import { newId } from "@/lib/ids";
import { runInChunks } from "@/db/chunk-utils";
import type { AuditLogInput } from "./types";

export async function createAuditLog(env: CloudflareEnv, input: AuditLogInput): Promise<void> {
	const db = getDb(env);
	await db.insert(auditLogs).values({
		id: newId("aud"),
		actorUserId: input.actorUserId ?? null,
		targetUserId: input.targetUserId ?? null,
		mailboxId: input.mailboxId ?? null,
		messageId: input.messageId ?? null,
		action: input.action,
		metadata: input.metadata ? JSON.stringify(input.metadata) : null,
	});
}

/** Eight bound values per row, so twelve rows stay under D1's 100-parameter limit. */
const AUDIT_LOG_ROWS_PER_INSERT = 12;

export async function createAuditLogs(env: CloudflareEnv, inputs: AuditLogInput[]): Promise<void> {
	const db = getDb(env);
	await runInChunks(
		inputs,
		(chunk) =>
			db.insert(auditLogs).values(
				chunk.map((input) => ({
					id: newId("aud"),
					actorUserId: input.actorUserId ?? null,
					targetUserId: input.targetUserId ?? null,
					mailboxId: input.mailboxId ?? null,
					messageId: input.messageId ?? null,
					action: input.action,
					metadata: input.metadata ? JSON.stringify(input.metadata) : null,
				})),
			),
		AUDIT_LOG_ROWS_PER_INSERT,
	);
}
