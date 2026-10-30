"use client";

import { useQuery } from "@tanstack/react-query";
import { authFetch } from "@/lib/auth/client";
import type { OverviewData } from "./overview-types";

/** One part of the overview: the JSON of a 2xx answer, or null when the request failed or was refused. */
async function part<T>(url: string, pick: (json: Record<string, unknown>) => T | undefined): Promise<T | null> {
	try {
		const response = await authFetch(url, { cache: "no-store" });
		if (!response.ok) return null;
		return pick((await response.json()) as Record<string, unknown>) ?? null;
	} catch {
		return null;
	}
}

const list =
	<T>(key: string) =>
	(json: Record<string, unknown>) =>
		json[key] as T[] | undefined;

/** Reads every part in parallel; the primary-only ones are skipped, not requested, for other admins. */
async function fetchOverview(primary: boolean): Promise<OverviewData> {
	const skip = async () => null;
	const [accounts, mailboxes, domains, migrations, databaseSize, backups, webhooks, aiErrors] = await Promise.all([
		part("/api/accounts", list<OverviewData["accounts"] extends (infer R)[] | null ? R : never>("accounts")),
		part("/api/mailboxes", list<NonNullable<OverviewData["mailboxes"]>[number]>("mailboxes")),
		part("/api/domains", list<NonNullable<OverviewData["domains"]>[number]>("domains")),
		part("/api/migrations/pending", (json) =>
			typeof json.pending === "number" ? { pending: json.pending } : undefined,
		),
		primary
			? part("/api/admin/database-size", (json) => json as unknown as NonNullable<OverviewData["databaseSize"]>)
			: skip(),
		primary ? part("/api/backups/health", (json) => json as unknown as NonNullable<OverviewData["backups"]>) : skip(),
		primary ? part("/api/webhooks", list<NonNullable<OverviewData["webhooks"]>[number]>("webhooks")) : skip(),
		primary ? part("/api/admin/agent/errors", list<NonNullable<OverviewData["aiErrors"]>[number]>("errors")) : skip(),
	]);
	return { accounts, mailboxes, domains, migrations, databaseSize, backups, webhooks, aiErrors };
}

export function useOverview(primary: boolean, enabled: boolean) {
	return useQuery({
		queryKey: ["admin-overview", primary],
		queryFn: () => fetchOverview(primary),
		enabled,
		staleTime: 30_000,
	});
}
