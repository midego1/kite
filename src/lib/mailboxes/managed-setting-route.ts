import type { z } from "zod";
import { getDb } from "@/db";
import { getEnv } from "@/lib/cloudflare";
import { getCurrentUser } from "@/lib/auth/cookies";
import { hasValidSessionMutationOrigin } from "@/lib/auth/origin";
import type { SessionUser } from "@/lib/auth/types";
import { readJsonBody } from "@/lib/http/request";
import { getMailboxAccessLevel } from "./access";
import type { MailboxAccessLevel } from "./types";

export type ManagedMailboxRequest<T> = { env: CloudflareEnv; user: SessionUser; access: MailboxAccessLevel; data: T };

/**
 * The shape every per-mailbox settings `PUT` a manager alone may change shares: session auth, a same-origin check,
 * a zod-validated JSON body naming `mailboxId`, and `canManage` access to it (`/api/agent/settings/ai`,
 * `/api/agent/settings/semantic`). Returns the parsed request, or the error response to answer with.
 */
export async function resolveManagedMailboxRequest<T extends { mailboxId: string }>(
	request: Request,
	schema: z.ZodType<T>,
): Promise<ManagedMailboxRequest<T> | { error: Response }> {
	const env = getEnv();
	const user = await getCurrentUser(env, request);
	if (!user) return { error: Response.json({ error: "Unauthorized" }, { status: 401 }) };
	if (!hasValidSessionMutationOrigin(request))
		return { error: Response.json({ error: "Invalid origin" }, { status: 403 }) };
	const parsed = schema.safeParse(await readJsonBody(request, 2_000).catch(() => null));
	if (!parsed.success) return { error: Response.json({ error: "Invalid request" }, { status: 400 }) };
	const access = await getMailboxAccessLevel(getDb(env), user, parsed.data.mailboxId);
	if (!access?.canManage)
		return { error: Response.json({ error: "Mailbox not found or permission denied" }, { status: 403 }) };
	return { env, user, access, data: parsed.data };
}
