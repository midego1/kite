import { getDb } from "@/db";
import { recordRuleMatch, resolveInboundAddress, type RoutingDecision } from "@/lib/email/routing";
import { KITE_FORWARDED_HEADER } from "@/lib/email/account-forwarding";

/**
 * `resolveIncomingMail` looked the address up and nothing on this install takes it: no active domain, mailbox, alias
 * or catch-all. Unlike `null` (the lookup failed), this is certain, so intake refuses the message instead of storing
 * mail the queue would only drop.
 */
export const NO_ROUTE = "no_route";

/** What the sender is told for `NO_ROUTE`, the same words the SMTP listener answers an unknown RCPT with. */
export const NO_ROUTE_REJECT_REASON = "No such recipient here";

/**
 * Resolves the routing decision for a live inbound message. Used by the Worker `email`
 * handler, where `forward()` and `setReject()` are still available on the message.
 *
 * Never throws: a routing failure must not stop mail from being stored, so it returns null, which callers store and
 * let the queue resolve again. Only a lookup that worked and found nothing returns `NO_ROUTE`.
 */
export async function resolveIncomingMail(
	env: CloudflareEnv,
	from: string,
	to: string,
): Promise<RoutingDecision | typeof NO_ROUTE | null> {
	try {
		const db = getDb(env);
		const decision = await resolveInboundAddress(db, to, from);
		if (!decision) return NO_ROUTE;
		if (decision.ruleId) {
			await recordRuleMatch(db, decision.ruleId).catch(() => undefined);
		}
		return decision;
	} catch (error) {
		console.error(`Routing resolution failed for ${to}`, error);
		return null;
	}
}

/**
 * Forwards to a Cloudflare Email Routing destination address. Returns whether the forward
 * succeeded so the caller can decide to still store the message.
 *
 * The destination must be a verified destination address in Cloudflare Email Routing.
 */
export async function forwardMessage(message: ForwardableEmailMessage, destination: string): Promise<boolean> {
	try {
		const headers = new Headers();
		headers.set(KITE_FORWARDED_HEADER, "1");
		await message.forward(destination, headers);
		return true;
	} catch (error) {
		console.error(`Forwarding failed for ${message.to} -> ${destination}`, error);
		return false;
	}
}
