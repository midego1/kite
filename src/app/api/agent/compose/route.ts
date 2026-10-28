import { getDb } from "@/db";
import { requireSessionUser } from "@/lib/api/auth";
import { hasValidSessionMutationOrigin } from "@/lib/auth/origin";
import { getEnv } from "@/lib/cloudflare";
import { ComposeRefusal, createComposeStream } from "@/lib/agent/compose";
import { reportAiErrorClass, reportAiFailure } from "@/lib/agent/ai-errors";
import { aiErrorHttpStatus } from "@/lib/agent/ai-error-utils";
import { InteractiveModelRefusedError, interactiveRefusal } from "@/lib/agent/interactive-model";
import { allowAgentRequest } from "@/lib/agent/rate-limit";
import { getAgentProviderPublicConfig } from "@/lib/agent/provider";
import { readJsonBody } from "@/lib/http/request";
import { getMailboxAccessLevel } from "@/lib/mailboxes/access";
import { composeRequestSchema } from "./schema";

/** An AI refusal (assistant off, no provider, external provider not allowed), logged and answered with its code. */
async function refused(env: CloudflareEnv, userId: string, mailboxId: string | null, error: unknown) {
	const body = await reportAiFailure(error, { env, feature: "compose", userId, mailboxId });
	return Response.json(body, { status: aiErrorHttpStatus(body.code) });
}

/** Whether Write with Kite can be offered in this mailbox; the composer shows its button only then. */
export async function GET(request: Request) {
	const env = getEnv();
	const auth = await requireSessionUser(env, request);
	if (auth.error) return auth.error;
	const mailboxId = new URL(request.url).searchParams.get("mailboxId");
	if (!mailboxId) return Response.json({ error: "Mailbox required" }, { status: 400 });
	const refusal =
		(await interactiveRefusal(env)) ?? ((await getAgentProviderPublicConfig(env)).configured ? null : "not_configured");
	const access = refusal ? null : await getMailboxAccessLevel(getDb(env), auth.user, mailboxId);
	const reason = refusal ?? (access?.canSendOnBehalf ? null : "no_send_access");
	return Response.json(reason ? { available: false, reason } : { available: true }, {
		headers: { "Cache-Control": "no-store" },
	});
}

/** Writes or rewrites composer text without tools; the answer streams as NDJSON for a preview the user inserts. */
export async function POST(request: Request) {
	const env = getEnv();
	const auth = await requireSessionUser(env, request);
	if (auth.error) return auth.error;
	if (!hasValidSessionMutationOrigin(request)) return Response.json({ error: "Invalid origin" }, { status: 403 });
	if (!(await allowAgentRequest(env, `compose:${auth.user.id}`))) {
		const body = await reportAiErrorClass(
			{ code: "rate_limited", status: null },
			{ env, feature: "compose", userId: auth.user.id },
		);
		return Response.json(body, { status: 429 });
	}
	const parsed = composeRequestSchema.safeParse(await readJsonBody(request, 32_000).catch(() => null));
	if (!parsed.success)
		return Response.json({ error: parsed.error.issues[0]?.message ?? "Invalid request" }, { status: 400 });
	const refusal = await interactiveRefusal(env);
	if (refusal) return refused(env, auth.user.id, parsed.data.mailboxId, new InteractiveModelRefusedError(refusal));
	try {
		const stream = await createComposeStream(env, auth.user, parsed.data, request.signal);
		return new Response(stream, {
			headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store" },
		});
	} catch (error) {
		if (error instanceof InteractiveModelRefusedError) return refused(env, auth.user.id, parsed.data.mailboxId, error);
		if (error instanceof ComposeRefusal)
			return Response.json(
				{
					error: error.message,
					...(error.code ? { code: error.code } : {}),
					...(error.details ? { details: error.details } : {}),
				},
				{ status: error.status },
			);
		throw error;
	}
}
