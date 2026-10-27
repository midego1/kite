import { getDb } from "@/db";
import { requireSessionUser } from "@/lib/api/auth";
import { hasValidSessionMutationOrigin } from "@/lib/auth/origin";
import { getEnv } from "@/lib/cloudflare";
import { ComposeRefusal, createComposeStream } from "@/lib/agent/compose";
import {
	InteractiveModelRefusedError,
	interactiveRefusal,
	type InteractiveRefusal,
} from "@/lib/agent/interactive-model";
import { allowAgentRequest } from "@/lib/agent/rate-limit";
import { getAgentProviderPublicConfig } from "@/lib/agent/provider";
import { readJsonBody } from "@/lib/http/request";
import { getMailboxAccessLevel } from "@/lib/mailboxes/access";
import { composeRequestSchema } from "./schema";

const REFUSALS: Record<InteractiveRefusal, { status: number; error: string }> = {
	assistant_disabled: { status: 403, error: "Assistant is disabled" },
	external_provider_not_allowed: {
		status: 403,
		error: "The primary admin has not allowed the external AI provider to read mail",
	},
	not_configured: { status: 503, error: "AI provider is not configured" },
};

const refused = (reason: InteractiveRefusal) =>
	Response.json({ error: REFUSALS[reason].error, code: reason }, { status: REFUSALS[reason].status });

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
	if (!(await allowAgentRequest(env, `compose:${auth.user.id}`)))
		return Response.json({ error: "Too many requests. Wait a moment and try again." }, { status: 429 });
	const parsed = composeRequestSchema.safeParse(await readJsonBody(request, 32_000).catch(() => null));
	if (!parsed.success)
		return Response.json({ error: parsed.error.issues[0]?.message ?? "Invalid request" }, { status: 400 });
	const refusal = await interactiveRefusal(env);
	if (refusal) return refused(refusal);
	try {
		const stream = await createComposeStream(env, auth.user, parsed.data, request.signal);
		return new Response(stream, {
			headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store" },
		});
	} catch (error) {
		if (error instanceof InteractiveModelRefusedError) return refused(error.reason);
		if (error instanceof ComposeRefusal)
			return Response.json(error.code ? { error: error.message, code: error.code } : { error: error.message }, {
				status: error.status,
			});
		throw error;
	}
}
