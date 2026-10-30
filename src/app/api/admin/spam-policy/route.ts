import { requireSessionAdmin } from "@/lib/api/auth";
import { isPrimaryAdmin } from "@/lib/auth/admin";
import { hasValidSessionMutationOrigin } from "@/lib/auth/origin";
import { getEnv } from "@/lib/cloudflare";
import { createAuditLog } from "@/lib/mailboxes/audit";
import { readStrictDmarc, saveStrictDmarc } from "@/lib/spam/dmarc-policy";

/** **Treat every DMARC failure as spam** (Admin → General), the owner's switch for the whole install. */
export async function GET(request: Request) {
	const env = getEnv();
	const auth = await requireSessionAdmin(env, request, isPrimaryAdmin);
	if (auth.error) return auth.error;
	return Response.json(await readStrictDmarc(env), { headers: { "Cache-Control": "no-store" } });
}

export async function PUT(request: Request) {
	const env = getEnv();
	const auth = await requireSessionAdmin(env, request, isPrimaryAdmin);
	if (auth.error) return auth.error;
	if (!hasValidSessionMutationOrigin(request)) return Response.json({ error: "Invalid origin" }, { status: 403 });
	const body = (await request.json().catch(() => null)) as { strictDmarc?: unknown } | null;
	if (typeof body?.strictDmarc !== "boolean")
		return Response.json({ error: "Send strictDmarc: true or false" }, { status: 400 });
	const current = await readStrictDmarc(env);
	if (current.migrationPending)
		return Response.json(
			{ error: "Apply the pending database update first", code: "MIGRATION_PENDING" },
			{ status: 409 },
		);
	await saveStrictDmarc(env, body.strictDmarc);
	if (current.strictDmarc !== body.strictDmarc)
		await createAuditLog(env, {
			actorUserId: auth.user.id,
			action: "spam.strict_dmarc_changed",
			metadata: { strictDmarc: body.strictDmarc },
		});
	return Response.json(await readStrictDmarc(env), { headers: { "Cache-Control": "no-store" } });
}
