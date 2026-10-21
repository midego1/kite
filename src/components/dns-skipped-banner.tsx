"use client";

import Link from "next/link";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Globe2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useCurrentUser } from "@/hooks/use-current-user";
import { canManageDomains } from "@/lib/auth/admin";
import { authFetch } from "@/lib/auth/client";
import type { SkippedDomain } from "./dns-skipped-banner-types";
import { dnsSkippedBannerContent, parseSkippedDomains } from "./dns-skipped-banner-utils";

// Under ["domains"] so every change on the Domains page refreshes the banner too.
const SKIPPED_DOMAINS_QUERY_KEY = ["domains", "dns-skipped"];

async function fetchSkippedDomains(): Promise<SkippedDomain[]> {
	const response = await authFetch("/api/domains", { cache: "no-store" });
	if (!response.ok) throw new Error(`Domains request failed (${response.status})`);
	return parseSkippedDomains(await response.json());
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
		queryKey: SKIPPED_DOMAINS_QUERY_KEY,
		queryFn: fetchSkippedDomains,
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
		<section
			role="status"
			aria-label="DNS setup"
			title={data.map((domain) => domain.hostname).join(", ")}
			className="mx-2 mb-2 flex shrink-0 items-center gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-1.5 text-xs text-amber-900 md:ml-0 md:mr-4"
		>
			<Globe2 className="h-3.5 w-3.5 shrink-0 text-amber-700" aria-hidden="true" />
			<p className="min-w-0 flex-1 truncate">
				<span className="font-medium">{content.title}.</span>{" "}
				{error ? (
					<span role="alert" className="text-red-700">
						{error}
					</span>
				) : (
					content.body
				)}
			</p>
			<Link href="/domains" className="shrink-0 underline underline-offset-2 hover:text-amber-950">
				Review
			</Link>
			<Button
				type="button"
				size="sm"
				variant="outline"
				className="h-6 border-amber-300 bg-white px-2 text-xs text-amber-900 hover:bg-amber-100"
				disabled={markDone.isPending}
				onClick={() => markDone.mutate(data)}
			>
				{markDone.isPending ? "Saving…" : "Mark as done"}
			</Button>
		</section>
	);
}
