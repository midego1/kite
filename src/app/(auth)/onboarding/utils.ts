import { authFetch } from "@/lib/auth/client";
import type { DomainCreateResult, DomainListResult, DomainPreflightResponse, MailboxCreateResult } from "./types";

export async function getDomains(): Promise<DomainListResult> {
	const res = await authFetch("/api/domains");
	return (await res.json()) as DomainListResult;
}

export async function checkDomain(hostname: string): Promise<DomainPreflightResponse> {
	const res = await authFetch("/api/domains/check", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ hostname }),
	});
	const data = (await res.json()) as Omit<DomainPreflightResponse, "ok">;
	return { ok: res.ok, ...data };
}

/** Adds the domain; with `skipDns` it is recorded without checking or changing any DNS. */
export async function createDomain(
	hostname: string,
	options: { enableSending?: boolean; replaceMxRecords?: boolean; skipDns?: boolean },
): Promise<{ ok: boolean; data: DomainCreateResult }> {
	const body = options.skipDns
		? { hostname, skipDns: true }
		: {
				hostname,
				enableRouting: true,
				enableSending: options.enableSending ?? false,
				replaceMxRecords: options.replaceMxRecords ?? false,
			};
	const res = await authFetch("/api/domains", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});

	return {
		ok: res.ok,
		data: (await res.json()) as DomainCreateResult,
	};
}

export async function createMailbox(
	domainId: string,
	localPart: string,
): Promise<{ ok: boolean; data: MailboxCreateResult }> {
	const res = await authFetch("/api/mailboxes", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ domainId, localPart, displayName: localPart }),
	});

	return {
		ok: res.ok,
		data: (await res.json()) as MailboxCreateResult,
	};
}
