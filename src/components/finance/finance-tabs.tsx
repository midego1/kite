"use client";

import Link from "next/link";
import { msg } from "@/lib/i18n/translator";
import { useT } from "@/lib/i18n/use-t";
import { cn } from "@/lib/utils";

export type FinanceTab = "subscriptions" | "payments";

const TABS = [
	{ id: "subscriptions", label: msg("Subscriptions"), href: "/finance" },
	{ id: "payments", label: msg("Payments"), href: "/finance?tab=payments" },
] as const;

/** The tab a `/finance` address opens: Payments with `?tab=payments`, Subscriptions otherwise. */
export const financeTabOf = (value: string | null): FinanceTab => (value === "payments" ? "payments" : "subscriptions");

/** Subscriptions and Payments, as links so each tab has its own address. */
export function FinanceTabs({ active }: { active: FinanceTab }) {
	const t = useT();
	return (
		<nav aria-label={t("Money Watch")} className="border-b border-neutral-200 px-4 md:px-8" data-finance-tabs>
			<ul className="mx-auto flex w-full max-w-4xl gap-4">
				{TABS.map((tab) => (
					<li key={tab.id}>
						<Link
							href={tab.href}
							scroll={false}
							aria-current={tab.id === active ? "page" : undefined}
							data-finance-tab={tab.id}
							className={cn(
								"-mb-px inline-flex border-b-2 px-1 py-2.5 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600",
								tab.id === active
									? "border-blue-600 text-blue-700"
									: "border-transparent text-neutral-600 hover:text-neutral-900",
							)}
						>
							{t(tab.label)}
						</Link>
					</li>
				))}
			</ul>
		</nav>
	);
}
