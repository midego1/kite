import { eq, and, ne } from "drizzle-orm";
import { getDb } from "@/db";
import { domains, mailboxes } from "@/db/schema";
import { selectRow, selectRows, insertRow } from "@/lib/db/pending-columns";
import { ensureMailboxDomainRouting } from "@/lib/mailboxes/domain-addresses";
import { newId } from "@/lib/ids";
import {
	disableEmailRouting,
	getEmailRoutingDns,
	getEmailRoutingSettings,
	getSendingSubdomainDns,
	deleteSendingSubdomain,
	listSendingSubdomains,
	type CfDnsRecord,
} from "@/lib/cloudflare-api";
import { deleteEmailRoutingRulesForDomain } from "@/lib/domains/cloudflare-cleanup";
import { isManualZone, provisionDomainOnCloudflare } from "@/lib/domains/provision";
import { getManualDomainDns } from "@/lib/domains/manual-dns";
import { rollbackDomainProvisioning } from "@/lib/domains/rollback";
import type { DomainProvisioningChanges } from "@/lib/domains/types";
import { findSendingSubdomain } from "@/lib/domains/sending-status";
import { preflightDomain } from "@/lib/domains/preflight";
import { hasCloudflareCredentials } from "@/lib/runtime";
import { clearedDnsSkip, isDomainHostname, skippedDomainDns, skippedDomainValues } from "@/lib/domains/skip-dns-utils";
import { deleteDomainWithMailboxes } from "@/lib/mailboxes/delete";
import type { MailboxDeletionResult } from "@/lib/mailboxes/delete-types";
import type { z } from "zod";
import type { addDomainSchema } from "@/lib/validators";

export type DomainDnsView = {
	routing: { records: CfDnsRecord[]; missing: CfDnsRecord[]; status?: string };
	sending: CfDnsRecord[];
	sendingEnabled: boolean;
	/** DKIM selector Cloudflare signs with, when a sending subdomain exists. */
	dkimSelector?: string;
	/** The matching sending subdomain, when the zone has the domain added for sending. */
	sendingSubdomain?: { name: string; tag: string };
};

export async function listUserDomains(env: CloudflareEnv, userId: string) {
	const db = getDb(env);
	return selectRows(db, domains, eq(domains.userId, userId));
}

type AddedDomain = {
	domain: typeof domains.$inferSelect;
	dns: DomainDnsView;
	changes: DomainProvisioningChanges;
};

/** Points the owner's all-domains mailboxes at a domain that was just added. */
async function routeAliasMailboxes(env: CloudflareEnv, userId: string): Promise<void> {
	const db = getDb(env);
	const aliasMailboxes = await db
		.select({
			id: mailboxes.id,
			domainId: mailboxes.domainId,
			localPart: mailboxes.localPart,
			useAllDomains: mailboxes.useAllDomains,
		})
		.from(mailboxes)
		.innerJoin(domains, eq(mailboxes.domainId, domains.id))
		.where(and(eq(domains.userId, userId), eq(mailboxes.useAllDomains, true)));
	const routingResults = await Promise.allSettled(
		aliasMailboxes.map((mailbox) => ensureMailboxDomainRouting(env, db, mailbox)),
	);
	for (const result of routingResults) {
		if (result.status === "rejected") console.warn("ensureMailboxDomainRouting", result.reason);
	}
}

/**
 * Records a domain without looking it up on Cloudflare or changing any DNS: the manual
 * zone, no receiving or sending provider and the "DNS skipped" flag, which the dashboard
 * warns about until an admin marks it done. The first Cloudflare setup on the domain page
 * adopts the real zone (`adoptCloudflareZone`). An already added domain is refused rather
 * than overwritten, since its zone and providers may be in use.
 */
export async function addSkippedDomainForUser(
	env: CloudflareEnv,
	userId: string,
	hostname: string,
): Promise<AddedDomain> {
	const db = getDb(env);
	const normalized = hostname.toLowerCase().trim();
	if (!isDomainHostname(normalized)) throw new Error("Enter a domain name such as example.com");
	const [claimed] = await db
		.select({ userId: domains.userId })
		.from(domains)
		.where(eq(domains.hostname, normalized))
		.limit(1);
	if (claimed && claimed.userId !== userId) throw new Error("Domain is already registered");
	if (claimed) throw new Error("This domain is already added. Set up its DNS from the Domains page.");

	const values = skippedDomainValues(newId("dom"), userId, normalized);
	await insertRow(db, domains, values);
	await routeAliasMailboxes(env, userId);
	const domain = (await selectRow(db, domains, eq(domains.id, values.id)))!;
	return {
		domain,
		dns: await getDomainDns(env, domain),
		changes: {
			zoneId: values.zoneId,
			enabledEmailRouting: false,
			createdSendingSubdomainTag: null,
			previousCatchAll: null,
			createdAddressRules: [],
			deletedMxRecords: [],
		},
	};
}

export async function addDomainForUser(
	env: CloudflareEnv,
	userId: string,
	hostname: string,
	options?: {
		enableRouting?: boolean;
		enableSending?: boolean;
		replaceMxRecords?: boolean;
		receivingProvider?: "none" | "cloudflare" | "resend" | "ses";
		sendingProvider?: "none" | "cloudflare" | "resend" | "ses";
	},
): Promise<AddedDomain> {
	const db = getDb(env);
	const normalizedHostname = hostname.toLowerCase().trim();
	const [claimedHostname] = await db
		.select({ userId: domains.userId })
		.from(domains)
		.where(eq(domains.hostname, normalizedHostname))
		.limit(1);
	if (claimedHostname && claimedHostname.userId !== userId) {
		throw new Error("Domain is already registered");
	}
	if (hasCloudflareCredentials(env)) {
		const { zone } = await preflightDomain(env, normalizedHostname);
		const [claimedZone] = await db
			.select({ userId: domains.userId })
			.from(domains)
			.where(and(eq(domains.zoneId, zone.id), ne(domains.userId, userId)))
			.limit(1);
		if (claimedZone) {
			throw new Error("Cloudflare zone is already registered to another account");
		}
	}
	// Email Routing is Cloudflare's way of receiving; another provider brings its own MX,
	// which its setup in the domain page creates once credentials exist.
	const receivingProvider = options?.receivingProvider ?? "cloudflare";
	// Cloudflare's sending subdomain is only provisioned when Cloudflare is the sender.
	const requestedSending = options?.sendingProvider ?? (options?.enableSending === false ? "none" : "cloudflare");
	const provisioned = await provisionDomainOnCloudflare(env, hostname, {
		...options,
		enableSending: requestedSending === "cloudflare",
		enableRouting: receivingProvider === "cloudflare" ? (options?.enableRouting ?? true) : false,
		replaceMxRecords: receivingProvider === "cloudflare" ? options?.replaceMxRecords : false,
	});
	let insertedDomainId: string | null = null;
	let domain: typeof domains.$inferSelect;

	try {
		const existing = await selectRow(db, domains, eq(domains.hostname, provisioned.hostname));
		if (existing && existing.userId !== userId) {
			throw new Error("Domain is already registered");
		}

		const domainId = existing?.id ?? newId("dom");
		const values = {
			id: domainId,
			userId,
			hostname: provisioned.hostname,
			zoneId: provisioned.zone.id,
			status:
				provisioned.routingEnabled || provisioned.sendingEnabled || receivingProvider !== "cloudflare"
					? ("active" as const)
					: ("pending" as const),
			receivingProvider,
			routingStatus: provisioned.routingStatus ?? null,
			sendingSubdomainTag: provisioned.sendingSubdomainTag,
			sendingRequested: provisioned.sendingRequested,
			...(options?.sendingProvider
				? { sendingProvider: options.sendingProvider }
				: existing && existing.sendingProvider !== "none"
					? {}
					: { sendingProvider: provisioned.sendingRequested ? ("cloudflare" as const) : ("none" as const) }),
			sendingEnabled: provisioned.sendingEnabled,
			routingEnabled: provisioned.routingEnabled,
			...clearedDnsSkip(existing),
		};

		if (existing) {
			await db.update(domains).set(values).where(eq(domains.id, domainId));
		} else {
			await insertRow(db, domains, values);
			insertedDomainId = domainId;
		}

		await routeAliasMailboxes(env, userId);

		const row = await selectRow(db, domains, eq(domains.id, domainId));
		domain = row!;
	} catch (err) {
		// The zone was already provisioned above. Anything that fails after that —
		// a hostname owned by another user, an unmigrated D1 schema — would otherwise
		// strand Email Routing and the sending subdomain with nothing referencing them.
		await rollbackDomainProvisioning(env, provisioned.changes);
		if (insertedDomainId) {
			try {
				await db.delete(domains).where(eq(domains.id, insertedDomainId));
			} catch (cleanupError) {
				console.warn("addDomainForUser: failed to remove partial domain row", cleanupError);
			}
		}
		throw err;
	}

	// Read the DNS view outside the rollback scope: the domain is fully set up by
	// now, so a failed status read must not tear it back down or make registration
	// delete the account that now owns the completed Cloudflare configuration.
	let dns: DomainDnsView;
	try {
		dns = await getDomainDns(env, domain);
	} catch (error) {
		console.warn("addDomainForUser: failed to read DNS status after provisioning", error);
		dns = {
			routing: { records: [], missing: [], status: provisioned.routingStatus },
			sending: [],
			sendingEnabled: provisioned.sendingEnabled,
		};
	}
	return { domain, dns, changes: provisioned.changes };
}

/** Adds a domain the way the add-domain form or API asked: with DNS skipped, or fully provisioned. */
export function addDomainAsRequested(
	env: CloudflareEnv,
	userId: string,
	input: z.infer<typeof addDomainSchema>,
): Promise<AddedDomain> {
	if (input.skipDns) return addSkippedDomainForUser(env, userId, input.hostname);
	return addDomainForUser(env, userId, input.hostname, {
		enableRouting: input.enableRouting,
		enableSending: input.enableSending,
		replaceMxRecords: input.replaceMxRecords,
		receivingProvider: input.receivingProvider,
		sendingProvider: input.sendingProvider,
	});
}

export async function getDomainDns(env: CloudflareEnv, domain: typeof domains.$inferSelect): Promise<DomainDnsView> {
	if (isManualZone(domain.zoneId)) {
		if (domain.dnsSkipped && hasCloudflareCredentials(env)) return skippedDomainDns();
		return getManualDomainDns(env, domain.hostname);
	}
	// Read the zone's actual sending state rather than trusting `sendingRequested`,
	// which goes stale when sending is enabled outside Kite (or when the row
	// was written before the subdomain existed). A missing Email Sending permission
	// must not take down the routing/DNS view, so a failed list degrades to none.
	const [routingDns, routingSettings, sendingSubdomains] = await Promise.all([
		getEmailRoutingDns(env, domain.zoneId),
		getEmailRoutingSettings(env, domain.zoneId),
		listSendingSubdomains(env, domain.zoneId).catch((error) => {
			console.warn("getDomainDns: failed to list sending subdomains", error);
			return [];
		}),
	]);
	const sendingSubdomain = findSendingSubdomain(domain.hostname, sendingSubdomains);
	let sending: CfDnsRecord[] = [];
	if (sendingSubdomain?.tag) {
		sending = await getSendingSubdomainDns(env, domain.zoneId, sendingSubdomain.tag).catch((error) => {
			console.warn("getDomainDns: failed to read sending subdomain DNS", error);
			return [];
		});
	}
	return {
		routing: {
			records: routingDns.records,
			missing: routingDns.missing,
			status: routingSettings.status,
		},
		sending,
		sendingEnabled: sendingSubdomain?.enabled ?? false,
		dkimSelector: sendingSubdomain?.dkim_selector,
		sendingSubdomain: sendingSubdomain ? { name: sendingSubdomain.name, tag: sendingSubdomain.tag } : undefined,
	};
}

export async function removeDomainForUser(
	env: CloudflareEnv,
	userId: string,
	domainId: string,
): Promise<MailboxDeletionResult> {
	const db = getDb(env);
	const domain = await selectRow(db, domains, and(eq(domains.id, domainId), eq(domains.userId, userId)));
	if (!domain) throw new Error("Domain not found");

	try {
		await deleteEmailRoutingRulesForDomain(env, domain.zoneId, domain.hostname);
	} catch (err) {
		console.warn("deleteEmailRoutingRulesForDomain", err);
	}

	const [otherDomainOnZone] = await db
		.select({ id: domains.id })
		.from(domains)
		.where(and(eq(domains.zoneId, domain.zoneId), ne(domains.id, domainId)))
		.limit(1);
	if (domain.routingEnabled && !otherDomainOnZone) {
		try {
			await disableEmailRouting(env, domain.zoneId);
		} catch (err) {
			console.warn("disableEmailRouting", err);
		}
	}

	if (domain.sendingSubdomainTag) {
		try {
			await deleteSendingSubdomain(env, domain.zoneId, domain.sendingSubdomainTag);
		} catch (err) {
			console.warn("deleteSendingSubdomain", err);
		}
	}

	return deleteDomainWithMailboxes(env, domainId);
}

export async function getDomainForUser(env: CloudflareEnv, userId: string, domainId: string) {
	const db = getDb(env);
	const domain = await selectRow(db, domains, and(eq(domains.id, domainId), eq(domains.userId, userId)));
	return domain ?? null;
}
