"use client";

import Link from "next/link";
import { NOTICE_LINK_CLASS } from "./notice-styles";
import { Notice } from "./ui/notice";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Globe2 } from "lucide-react";
import { useCurrentUser } from "@/hooks/use-current-user";
import { canManageDomains } from "@/lib/auth/admin";
import { authFetch } from "@/lib/auth/client";
import type { SkippedDomain } from "./dns-skipped-banner-types";
import { dnsSkippedBannerContent, parseSkippedDomains } from "./dns-skipped-banner-utils";

// Under ["domains"] so every change on the Domains page refreshes the banner too.
const SKIPPED_DOMAINS_QUERY_KEY = ["domains", "dns-skipped"];

async function fetchSkippedDomains(userId: string): Promise<SkippedDomain[]> {
	const response = await authFetch("/api/domains", { cache: "no-store" });
	if (!response.ok) throw new Error(`Domains request failed (${response.status})`);
	return parseSkippedDomains(await response.json(), userId);
}

async function markDnsDone(domains: SkippedDomain[]): Promise<void> {
	for (const domain of domains) {
		const response = await authFetch(`/api/domains/${domain.id}`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ dnsSkipped: false }),
		});
		if (!response.ok) {
			const data = (await response.json().catch(() => ({}))) as { error?: string };
			throw new Error(data.error ?? "Could not mark the DNS setup as done");
		}
	}
}

/** Reminds domain managers that a domain was added with DNS skipped, until they mark it done. */
export function DnsSkippedBanner() {
	const user = useCurrentUser();
	const allowed = !!user && canManageDomains(user);
	const queryClient = useQueryClient();
	const [error, setError] = useState<string | null>(null);
	const { data } = useQuery({
		queryKey: [...SKIPPED_DOMAINS_QUERY_KEY, user?.id],
		queryFn: () => fetchSkippedDomains(user!.id),
		enabled: allowed,
		refetchOnWindowFocus: false,
		retry: false,
	});
	const markDone = useMutation({
		mutationFn: markDnsDone,
		onMutate: () => setError(null),
		onError: (err) => setError(err instanceof Error ? err.message : "Could not mark the DNS setup as done"),
		onSettled: () => queryClient.invalidateQueries({ queryKey: ["domains"] }),
	});

	if (!allowed || !data?.length) return null;
	const content = dnsSkippedBannerContent(data);

	return (
		<Notice
			tone="warning"
			compact
			icon={Globe2}
			role="status"
			aria-label="DNS setup"
			tooltip={data.map((domain) => domain.hostname).join(", ")}
			title={content.title}
		>
			<p className="line-clamp-2 opacity-90">
				{error ? (
					<span role="alert" className="text-red-600">
						{error}
					</span>
				) : (
					content.body
				)}
			</p>
			<div className="mt-1.5 flex items-center gap-3">
				<Link href="/domains" className={NOTICE_LINK_CLASS}>
					Review
				</Link>
				<button
					type="button"
					className={NOTICE_LINK_CLASS}
					disabled={markDone.isPending}
					onClick={() => markDone.mutate(data)}
				>
					{markDone.isPending ? "Saving…" : "Mark as done"}
				</button>
			</div>
		</Notice>
	);
}
