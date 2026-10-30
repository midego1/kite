"use client";

import Link from "next/link";
import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link2Off } from "lucide-react";
import { useCurrentUser } from "@/hooks/use-current-user";
import { MODULE_NOTICE_EVENT } from "@/hooks/message-realtime-utils";
import type { ModuleNoticeEvent } from "@/hooks/message-realtime-types";
import { authFetch } from "@/lib/auth/client";
import { NOTICE_LINK_CLASS, WARNING_NOTICE_CLASS } from "./notice-styles";
import { connectedAccountsBannerContent, parseAttentionAccounts } from "./connected-accounts-banner-utils";

// Under ["external-accounts"] so every change on the Connected accounts page refreshes the notice too.
const ATTENTION_QUERY_KEY = ["external-accounts", "attention"];

async function fetchAttention() {
	const response = await authFetch("/api/external-accounts/attention", { cache: "no-store" });
	if (!response.ok) throw new Error(`Connected accounts request failed (${response.status})`);
	return parseAttentionAccounts(await response.json());
}

/**
 * Tells the owner when a connected account stopped bringing in mail (spec §6.5): a failed sign-in, a certificate
 * problem or an error that stopped checking. A sync that fails a sign-in also sends a realtime notice, which
 * refreshes this one at once.
 */
export function ConnectedAccountsBanner() {
	const user = useCurrentUser();
	const queryClient = useQueryClient();
	const { data } = useQuery({
		queryKey: [...ATTENTION_QUERY_KEY, user?.id],
		queryFn: fetchAttention,
		enabled: !!user,
		refetchOnWindowFocus: true,
		refetchInterval: 5 * 60_000,
		retry: false,
	});
	useEffect(() => {
		function onNotice(event: Event) {
			if ((event as CustomEvent<ModuleNoticeEvent>).detail?.moduleId !== "connected_accounts") return;
			void queryClient.invalidateQueries({ queryKey: ATTENTION_QUERY_KEY });
		}
		window.addEventListener(MODULE_NOTICE_EVENT, onNotice);
		return () => window.removeEventListener(MODULE_NOTICE_EVENT, onNotice);
	}, [queryClient]);

	if (!data?.length) return null;
	const content = connectedAccountsBannerContent(data);
	return (
		<section
			role="status"
			aria-label="Connected accounts"
			title={data.map((account) => account.address).join(", ")}
			className={WARNING_NOTICE_CLASS}
		>
			<Link2Off className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden="true" />
			<div className="min-w-0 flex-1">
				<p className="truncate font-medium">{content.title}</p>
				<p className="mt-0.5 line-clamp-2 opacity-90">{content.body}</p>
				<div className="mt-1.5 flex items-center gap-3">
					<Link href="/settings/connected-accounts" className={NOTICE_LINK_CLASS}>
						{data.some((account) => account.status === "auth_failed") ? "Reconnect" : "Review"}
					</Link>
				</div>
			</div>
		</section>
	);
}
