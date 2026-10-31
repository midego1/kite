"use client";

import Link from "next/link";
import { CheckCircle2 } from "lucide-react";
import { AiFailuresWhy } from "@/components/agent/ai-failures-why";
import { Notice } from "@/components/ui/notice";
import { Skeleton } from "@/components/ui/skeleton";
import { attentionItems } from "@/app/(admin)/admin/overview-utils";
import { useOverview } from "@/app/(admin)/admin/use-overview";
import type { AttentionTone } from "@/app/(admin)/admin/overview-types";
import { attentionHref, healthLines } from "./command-center-utils";
import { CommandCenterCard } from "./command-center-card";

/**
 * The notices restyled for the card's surface: the warning as the command center's amber callout, information
 * as a faint wash of the accent (the page tones would put a solid blue block, or an inverted amber, on it).
 */
const ATTENTION_NOTICE_CLASS: Record<AttentionTone, string> = {
	warning: "border-cc-warn-border bg-cc-warn-surface text-cc-warn-text dark:text-cc-warn-text",
	info: "border-cc-info-border bg-cc-info-surface text-neutral-800",
	error: "",
};

/**
 * The Needs attention card, for admins only and loaded as its own chunk (command-center-admin-card-lazy.tsx):
 * the admin overview's list without the migrations item (the pane's notice shows that one with Apply now),
 * "Nothing else" otherwise, and a line each for a healthy last backup and a database within its limit. The
 * overview parts are read under the keys the admin cards use, from the cache while fresh.
 */
export function CommandCenterAdminCard({ primary }: { primary: boolean }) {
	const overview = useOverview(primary, true, { refetchOnMount: true });
	const items = attentionItems(overview.data, primary).filter((item) => item.id !== "migrations");
	const health = healthLines(overview.data, new Date());
	return (
		<CommandCenterCard
			title="Needs attention"
			action={{ label: "Admin overview", href: "/admin" }}
			testId="command-center-attention"
		>
			{overview.loading ? (
				<Skeleton className="h-10 w-full rounded-xl" />
			) : (
				<div className="space-y-2">
					{items.map((item) => (
						<Notice
							key={item.id}
							tone={item.tone}
							className={ATTENTION_NOTICE_CLASS[item.tone]}
							title={item.title}
							actions={
								<>
									{item.why && <AiFailuresWhy />}
									<Link
										href={attentionHref(item.href)}
										className="text-sm font-medium underline underline-offset-2 hover:opacity-80"
									>
										{item.hrefLabel}
									</Link>
								</>
							}
							data-testid={`command-center-attention-${item.id}`}
						>
							{item.detail}
						</Notice>
					))}
					{items.length === 0 && (
						<p
							className="flex items-center gap-2 py-1.5 text-sm text-neutral-700"
							data-testid="command-center-all-clear"
						>
							<CheckCircle2 className="h-4 w-4 text-cc-ok" aria-hidden="true" />
							Nothing else needs your attention.
						</p>
					)}
					{health.map((line) => (
						<p key={line.id} className="flex items-center gap-3 py-1 text-sm text-neutral-700">
							<span aria-hidden="true" className="h-2 w-2 shrink-0 rounded-full bg-cc-ok" />
							<span className="min-w-0 flex-1 truncate">{line.text}</span>
							<span className="shrink-0 text-xs text-neutral-600">{line.detail}</span>
						</p>
					))}
				</div>
			)}
		</CommandCenterCard>
	);
}
