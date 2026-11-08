import { and, eq, or } from "drizzle-orm";
import type { AppDatabase } from "@/db";
import { domains } from "@/db/schema";
import { assistantAddresses } from "@/db/schema/assistant-email";
import { isAddressDelivered, isAssistantAddressTaken } from "@/lib/email/routing";
import { normalizeRecipientLocalPart } from "@/lib/email/recipient-address";
import type { SessionUser } from "@/lib/auth/types";

/** A domain this admin can manage: their own, or (as a manager) one owned by whoever created them. */
export async function managedDomain(db: AppDatabase, admin: SessionUser, domainId: string) {
	const [domain] = await db
		.select()
		.from(domains)
		.where(
			and(
				eq(domains.id, domainId),
				or(eq(domains.userId, admin.id), admin.createdByUserId ? eq(domains.userId, admin.createdByUserId) : undefined),
			),
		)
		.limit(1);
	return domain ?? null;
}

export type AssistantAddressCheck =
	{ ok: true } | { ok: false; error: string; code: "DOMAIN_NOT_READY" | "ADDRESS_IN_USE" };

/**
 * Whether `domain` can host an assistant address (spec §13): active, a receiving provider that authenticates
 * mail Kite trusts (`cloudflare` or `ses`; Resend is out of scope for now, decision 19), and a sending provider
 * to send the reply from. `localPart` must not already be a mailbox, an alias, or (when `excludeId` is given, an
 * address being renamed) another assistant address.
 */
export async function checkAssistantAddress(
	db: AppDatabase,
	domain: typeof domains.$inferSelect,
	localPart: string,
	excludeId?: string,
): Promise<AssistantAddressCheck> {
	if (
		domain.status !== "active" ||
		!["cloudflare", "ses"].includes(domain.receivingProvider) ||
		domain.sendingProvider === "none"
	)
		return {
			ok: false,
			code: "DOMAIN_NOT_READY",
			error:
				"This domain needs to be active, receive through Cloudflare Email Routing or Amazon SES, and have a sending provider set up.",
		};
	const normalized = normalizeRecipientLocalPart(localPart);
	if (!normalized) return { ok: false, code: "ADDRESS_IN_USE", error: "Enter an address" };
	if (await isAddressDelivered(db, domain.id, `${normalized}@${domain.hostname}`))
		return { ok: false, code: "ADDRESS_IN_USE", error: "This address already delivers to a mailbox" };
	if (excludeId === undefined && (await isAssistantAddressTaken(db, domain.id, normalized)))
		return { ok: false, code: "ADDRESS_IN_USE", error: "An assistant address already uses this name" };
	return { ok: true };
}

export function publicAssistantAddress(row: typeof assistantAddresses.$inferSelect, hostname: string) {
	return {
		id: row.id,
		domainId: row.domainId,
		localPart: row.localPart,
		address: `${row.localPart}@${hostname}`,
		enabled: row.enabled,
		createdAt: row.createdAt,
	};
}
