import { newId } from "@/lib/ids";
import {
	forwardedMarker,
	getAccountForwardingDestination,
	KITE_FORWARDED_HEADER,
	wasForwardedByKite,
} from "@/lib/email/account-forwarding";
import { NO_ROUTE, NO_ROUTE_REJECT_REASON, resolveIncomingMail } from "@/lib/email/incoming";
import type { InboundQueueMessage } from "@/lib/email/inbound";
import type { IntakeActions, IntakeInput, IntakeResult } from "@/lib/email/intake-types";

type IncomingDecision = Awaited<ReturnType<typeof resolveIncomingMail>>;

/**
 * Acts on a reject or forward decision through the callbacks: the result when intake ends there, otherwise where
 * the message was forwarded (null when it was not) before it is stored.
 */
async function applyRouting(
	decision: IncomingDecision,
	actions: IntakeActions,
	marker: Record<string, string>,
): Promise<{ result: IntakeResult } | { forwardedTo: string | null }> {
	if (decision === NO_ROUTE || decision?.action === "reject") {
		const reason =
			decision === NO_ROUTE ? NO_ROUTE_REJECT_REASON : (decision.rejectReason ?? "Message rejected by routing rule");
		await actions.reject?.(reason);
		return { result: { action: "reject", reason } };
	}
	if (decision?.action !== "forward" || !decision.forwardTo) return { forwardedTo: null };
	// A provider that cannot forward (Resend, SES) has nothing to keep for a forward rule without a copy.
	if (!actions.forward && !decision.keepCopy) return { result: { action: "forward", forwardedTo: null } };
	const forwarded = await actions.forward?.(decision.forwardTo, marker);
	if (!forwarded) return { forwardedTo: null };
	// A failed forward is stored, so mail is never silently lost.
	return decision.keepCopy
		? { forwardedTo: decision.forwardTo }
		: { result: { action: "forward", forwardedTo: decision.forwardTo } };
}

/**
 * What the Worker `email` handler does, for runtimes that hand us the whole
 * message as bytes (an SMTP listener, or the Cloudflare relay webhook):
 * resolve domain rules, act on reject and forward through the supplied
 * callbacks, then store the raw MIME and enqueue it for parsing. An address
 * nothing routes is refused like a reject rule; a failed lookup is stored.
 */
export async function intakeIncomingMail(
	env: CloudflareEnv,
	input: IntakeInput,
	actions: IntakeActions,
): Promise<IntakeResult> {
	const marker = { [KITE_FORWARDED_HEADER]: await forwardedMarker(env) };
	const routed = await applyRouting(await resolveIncomingMail(env, input.from, input.to), actions, marker);
	if ("result" in routed) return routed.result;
	const { forwardedTo } = routed;

	if (!(await wasForwardedByKite(env, (name) => input.headers[name]))) {
		const destination = await getAccountForwardingDestination(env, input.to);
		if (destination) await actions.forward?.(destination, marker);
	}

	const rawR2Key = `inbound/${Date.now()}-${newId()}.eml`;
	await env.BUCKET.put(rawR2Key, input.raw, {
		httpMetadata: { contentType: "message/rfc822" },
		customMetadata: { from: input.from, to: input.to },
	});
	const payload: InboundQueueMessage = {
		from: input.from,
		to: input.to,
		rawR2Key,
		headers: input.headers,
		authenticationResults: input.authenticationResults ?? null,
		...(input.privateClient ? { privateClient: true } : {}),
	};
	await env.INBOUND_QUEUE.send(payload);
	return { action: "store", rawR2Key, forwardedTo };
}
