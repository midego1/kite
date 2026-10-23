import { getDb } from "@/db";
import { getEnv } from "@/lib/cloudflare";
import { getCurrentUser } from "@/lib/auth/cookies";
import { hasValidSessionMutationOrigin } from "@/lib/auth/origin";
import { getMailboxAccessLevel } from "@/lib/mailboxes/access";
import { editSenderList } from "@/lib/agent/auto-read/sender-lists";
import { parseSenderListEdit } from "@/lib/agent/auto-read/sender-lists-utils";

/** `{ mailboxId, list: "trusted" | "muted", add }` or `{ ..., remove }`; answers the list as stored afterwards. */
export async function POST(request: Request) {
	const env = getEnv();
	const user = await getCurrentUser(env, request);
	if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
	if (!hasValidSessionMutationOrigin(request)) return Response.json({ error: "Invalid origin" }, { status: 403 });
	const edit = parseSenderListEdit(await request.json().catch(() => null));
	if (typeof edit === "string") return Response.json({ error: edit }, { status: 400 });
	const access = await getMailboxAccessLevel(getDb(env), user, edit.mailboxId);
	if (!access?.canManage) return Response.json({ error: "Mailbox not found or permission denied" }, { status: 403 });
	const result = await editSenderList(env, access, edit);
	if ("error" in result) return Response.json({ error: result.error }, { status: 400 });
	return Response.json(result);
}
