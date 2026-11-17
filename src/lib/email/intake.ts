import { newId } from "@/lib/ids";
import {
	forwardedMarker,
	getAccountForwardingDestination,
	KITE_FORWARDED_HEADER,
	wasForwardedByKite,
} from "@/lib/email/account-forwarding";
import { NO_ROUTE, NO_ROUTE_REJECT_REASON, resolveIncomingMail } from "@/lib/email/incoming";
import type { InboundQueueMessage } from "@/lib/email/inbound";
import { enqueueOrDiscard } from "@/lib/email/inbound-enqueue";
import { receivedRawMetadata } from "@/lib/email/redelivery";
import { INBOUND_QUEUE_PAYLOAD_TOO_LARGE_REASON, inboundQueuePayloadTooLarge } from "@/lib/email/inbound-queue-utils";
import type { IntakeActions, IntakeInput, IntakeResult } from "@/lib/email/intake-types";

type IncomingDecision = Awaited<ReturnType<typeof resolveIncomingMail>>;

/**
 * Acts on a reject decision, and on a forward rule without a copy, through the callbacks: the result when intake ends
 * there. Otherwise where a forward rule with a copy forwards to, which happens only once the message is stored.
 */
async function applyRouting(
	decision: IncomingDecision,
	actions: IntakeActions,
	marker: Record<string, string>,
): Promise<{ result: IntakeResult } | { copyTo: string | null }> {
	if (decision === NO_ROUTE || decision?.action === "reject") {
		const reason =
			decision === NO_ROUTE ? NO_ROUTE_REJECT_REASON : (decision.rejectReason ?? "Message rejected by routing rule");
		await actions.reject?.(reason);
		return { result: { action: "reject", reason } };
	}
	if (decision?.action !== "forward" || !decision.forwardTo) return { copyTo: null };
	if (decision.keepCopy) return { copyTo: decision.forwardTo };
	// A provider that cannot forward (Resend, SES) has nothing to keep for a forward rule without a copy.
	if (!actions.forward) return { result: { action: "forward", forwardedTo: null } };
	// A failed forward is stored, so mail is never silently lost.
	if (await actions.forward(decision.forwardTo, marker))
		return { result: { action: "forward", forwardedTo: decision.forwardTo } };
	return { copyTo: null };
}

/**
 * The forwards that keep a copy, once the message is stored and queued: the rule's (when it asked for a copy) and the
 * account's. They never throw, since the message is already Kite's and a thrown error would make the sender deliver it
 * again. Returns where the rule's copy went, or null.
 */
async function forwardCopies(
	env: CloudflareEnv,
	actions: IntakeActions,
	copyTo: string | null,
	header: (name: string) => string | undefined,
	input: IntakeInput,
	marker: Record<string, string>,
): Promise<string | null> {
	let forwardedTo: string | null = null;
	try {
		if (copyTo && (await actions.forward?.(copyTo, marker))) forwardedTo = copyTo;
		if (!(await wasForwardedByKite(env, header))) {
			const destination = await getAccountForwardingDestination(env, input.to);
			if (destination) await actions.forward?.(destination, marker);
		}
	} catch (error) {
		console.error("Forwarding a stored message failed", error);
	}
	return forwardedTo;
}

/**
 * What the Worker `email` handler does, for runtimes that hand us the whole
 * message as bytes (an SMTP listener, the Cloudflare relay webhook, Resend and SES):
 * resolve domain rules, act on reject and a forward without a copy through the supplied
 * callbacks, then store the raw MIME, enqueue it for parsing and only then forward copies. An address
 * nothing routes is refused like a reject rule; a failed lookup is stored. A queue message too large to send is
 * refused, since it would be on every retry. Throws only on a failure a retry can fix, and only before the message
 * is queued.
 */
export async function intakeIncomingMail(
	env: CloudflareEnv,
	input: IntakeInput,
	actions: IntakeActions,
): Promise<IntakeResult> {
	const header = (name: string) => input.headers[name] ?? input.headers[name.toLowerCase()];
	const marker = { [KITE_FORWARDED_HEADER]: await forwardedMarker(env, header) };
	const routed = await applyRouting(await resolveIncomingMail(env, input.from, input.to), actions, marker);
	if ("result" in routed) return routed.result;

	const rawR2Key = input.rawR2Key ?? `inbound/${Date.now()}-${newId()}.eml`;
	const payload: InboundQueueMessage = {
		from: input.from,
		to: input.to,
		rawR2Key,
		headers: input.headers,
		authenticationResults: input.authenticationResults ?? null,
		...(input.privateClient ? { privateClient: true } : {}),
	};
	if (inboundQueuePayloadTooLarge(payload)) {
		await actions.reject?.(INBOUND_QUEUE_PAYLOAD_TOO_LARGE_REASON);
		return { action: "reject", reason: INBOUND_QUEUE_PAYLOAD_TOO_LARGE_REASON };
	}
	await env.BUCKET.put(rawR2Key, input.raw, {
		httpMetadata: { contentType: "message/rfc822" },
		customMetadata: await receivedRawMetadata(input.from, input.to, input.raw),
	});
	await enqueueOrDiscard(env, payload);
	const forwardedTo = await forwardCopies(env, actions, routed.copyTo, header, input, marker);
	return { action: "store", rawR2Key, forwardedTo };
}
