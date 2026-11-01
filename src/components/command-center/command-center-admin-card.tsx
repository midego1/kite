"use client";

import Link from "next/link";
import { CheckCircle2, ShieldCheck } from "lucide-react";
import { AiFailuresWhy } from "@/components/agent/ai-failures-why";
import { SUCCESS_TEXT_CLASS } from "@/components/notice-styles";
import { Notice } from "@/components/ui/notice";
import { Skeleton } from "@/components/ui/skeleton";
import { attentionItems } from "@/app/(admin)/admin/overview-utils";
import { useOverview } from "@/app/(admin)/admin/use-overview";
import { attentionHref, healthLines } from "./command-center-utils";
import {
	COMMAND_CENTER_DETAIL_CLASS,
	COMMAND_CENTER_LIST_CLASS,
	COMMAND_CENTER_ROW_CLASS,
	CommandCenterCard,
	CommandCenterPill,
} from "./command-center-card";

const CHECK_CLASS = `h-4 w-4 shrink-0 ${SUCCESS_TEXT_CLASS}`;

/**
 * The Needs attention card, for admins only and loaded as its own chunk (command-center-admin-card-lazy.tsx):
 * the admin overview's list without the migrations item (the pane's notice shows that one with Apply now), as
 * the same notices the overview draws, an "All clear" row otherwise, and a row each for a healthy last backup and
 * a database within its limit. The overview parts are read under the keys the admin cards use, from the cache
 * while fresh.
 */
export function CommandCenterAdminCard({ primary }: { primary: boolean }) {
	const overview = useOverview(primary, true, { refetchOnMount: true });
	const items = attentionItems(overview.data, primary).filter((item) => item.id !== "migrations");
	const health = healthLines(overview.data, new Date());
	return (
		<CommandCenterCard
			title="Needs attention"
			icon={ShieldCheck}
			action={{ label: "Admin overview", href: "/admin" }}
			testId="command-center-attention"
		>
			{overview.loading ? (
				<Skeleton className="h-10 rounded-xl" />
			) : (
				<div className="space-y-2">
					{items.map((item) => (
						<Notice
							key={item.id}
							tone={item.tone}
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
						<p className={COMMAND_CENTER_ROW_CLASS} data-testid="command-center-all-clear">
							<CheckCircle2 className={CHECK_CLASS} aria-hidden="true" />
							<span className="min-w-0 flex-1 truncate">Nothing else needs your attention.</span>
							<CommandCenterPill tone="ok" className="ml-auto">
								All clear
							</CommandCenterPill>
						</p>
					)}
					{health.length > 0 && (
						<div className={COMMAND_CENTER_LIST_CLASS}>
							{health.map((line) => (
								<p key={line.id} className={COMMAND_CENTER_ROW_CLASS}>
									<CheckCircle2 className={CHECK_CLASS} aria-hidden="true" />
									<span className="min-w-0 flex-1 truncate">{line.text}</span>
									<span className={COMMAND_CENTER_DETAIL_CLASS}>{line.detail}</span>
								</p>
							))}
						</div>
					)}
				</div>
			)}
		</CommandCenterCard>
	);
}
