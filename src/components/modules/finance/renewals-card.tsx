"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { CommandCenterCard } from "@/components/command-center/command-center-card";
import type { SubscriptionList } from "@/components/finance/subscriptions-types";
import { viewerLocale, viewerToday } from "@/components/finance/use-subscriptions";
import type { ReadingPaneSlotContext } from "@/components/modules/client-registry-types";
import { authFetch } from "@/lib/auth/client";
import { renewalLines } from "./renewals-card-utils";

/**
 * The command center's Money Watch card: the viewer's own subscriptions that renew, end a trial or failed a
 * payment this week, with a link to Subscriptions. It draws nothing until they are in, and nothing at all when
 * they cannot be read (Money Watch off, the database update not applied yet, an error).
 */
export function RenewalsCard(_context: ReadingPaneSlotContext) {
	const [list, setList] = useState<SubscriptionList | null>(null);

	useEffect(() => {
		let live = true;
		void authFetch("/api/finance/subscriptions")
			.then(async (response) => {
				if (!response.ok) throw new Error();
				return (await response.json()) as SubscriptionList;
			})
			.then((data) => {
				if (live && !data.migrationPending) setList(data);
			})
			.catch(() => {});
		return () => {
			live = false;
		};
	}, []);

	if (!list) return null;
	const { lines, more } = renewalLines(list.subscriptions, viewerToday(), viewerLocale());
	return (
		<CommandCenterCard
			title="Money Watch"
			action={{ label: "Subscriptions", href: "/finance" }}
			testId="command-center-renewals"
		>
			{lines.length === 0 ? (
				<p className="py-1.5 text-sm text-neutral-700">Nothing renews this week.</p>
			) : (
				<ul className="divide-y divide-neutral-200/70">
					{lines.map((line) => (
						<li key={line.id}>
							<Link
								href={line.href}
								className="flex items-center gap-3 py-2 text-sm text-neutral-900 hover:text-blue-700"
								data-renewal={line.urgent ? "failed" : "due"}
							>
								<span
									className={`w-16 shrink-0 whitespace-nowrap ${line.urgent ? "font-medium text-amber-700" : "text-neutral-500"}`}
								>
									{line.when}
								</span>
								<span className="min-w-0 flex-1 truncate">{line.what}</span>
								<span className="max-w-[40%] shrink-0 truncate text-xs text-neutral-500">{line.meta}</span>
							</Link>
						</li>
					))}
				</ul>
			)}
			{more > 0 && (
				<Link href="/finance" className="mt-1 block text-xs font-medium text-blue-700 hover:underline">
					{more} more this week
				</Link>
			)}
		</CommandCenterCard>
	);
}
