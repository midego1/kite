import { ATTACHMENT_OBJECT_ROWS_SQL } from "@/lib/email/attachment-storage-utils";
import { callStorageHook } from "./module-hooks";

type UsageEnv = { DB: D1Database };

async function sumOf(env: UsageEnv, sql: string): Promise<{ objects: number; bytes: number }> {
	try {
		const row = await env.DB.prepare(sql).first<{ objects: number; bytes: number | null }>();
		return { objects: Number(row?.objects ?? 0), bytes: Number(row?.bytes ?? 0) };
	} catch {
		return { objects: 0, bytes: 0 };
	}
}

/** Objects and bytes per class from D1; raw messages have no recorded size, so mail bytes cover attachments only. */
export async function usageByClass(env: UsageEnv) {
	const [raws, attachments, backups, drive] = await Promise.all([
		sumOf(env, "SELECT count(*) AS objects, 0 AS bytes FROM messages WHERE raw_r2_key IS NOT NULL"),
		sumOf(
			env,
			`SELECT count(*) AS objects, sum(size) AS bytes FROM (SELECT max(size) AS size FROM message_attachments WHERE ${ATTACHMENT_OBJECT_ROWS_SQL} GROUP BY r2_key)`,
		),
		sumOf(env, "SELECT count(*) AS objects, sum(size) AS bytes FROM backups WHERE r2_key IS NOT NULL"),
		callStorageHook<{ objects: number; bytes: number }>("drive", "usage", {}).catch(() => null),
	]);
	return {
		mail: { objects: raws.objects + attachments.objects, bytes: attachments.bytes },
		drive: { objects: drive?.objects ?? 0, bytes: drive?.bytes ?? 0 },
		backups,
	};
}
