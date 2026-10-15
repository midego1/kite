"use client";

import { useState, type ComponentProps, type ReactNode } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ChevronDown, Plus, WalletCards } from "lucide-react";
import { mobilePrimaryActionClass } from "@/components/page-header-utils";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { SubscriptionDialog } from "./subscription-dialog";
import { SubscriptionDrawer } from "./subscription-drawer";
import { SubscriptionRow } from "./subscription-row";
import { SubscriptionTotals } from "./subscription-totals";
import type { StatusFilter, SubscriptionGroups, SubscriptionItem } from "./subscriptions-types";
import { groupSubscriptions, visibleSections } from "./subscriptions-utils";
import { useSubscriptionDetail, useSubscriptionList, viewerLocale, viewerToday } from "./use-subscriptions";

const FILTERS: { value: StatusFilter; label: string }[] = [
	{ value: "current", label: "Active and trials" },
	{ value: "ended", label: "Cancelled and expired" },
	{ value: "all", label: "All" },
];

function Section({ id, title, count, children }: { id: string; title: string; count: number; children: ReactNode }) {
	return (
		<section aria-labelledby={`finance-section-${id}`} data-finance-section={id}>
			<h2 id={`finance-section-${id}`} className="mb-2 px-1 text-sm font-semibold text-neutral-700">
				{title} <span className="font-normal text-neutral-500">{count}</span>
			</h2>
			<ul className="divide-y divide-neutral-100 overflow-hidden rounded-3xl bg-white">{children}</ul>
		</section>
	);
}

type RowProps = Omit<ComponentProps<typeof SubscriptionRow>, "item" | "reason">;

/** "Cancelled and expired", collapsed unless the filter shows only those rows. */
function EndedSection({
	items,
	filter,
	rowProps,
}: {
	items: SubscriptionItem[];
	filter: StatusFilter;
	rowProps: RowProps;
}) {
	const [open, setOpen] = useState(false);
	if (items.length === 0) return null;
	const expanded = filter === "ended" || open;
	return (
		<section aria-labelledby="finance-section-ended" data-finance-section="ended">
			<h2 id="finance-section-ended" className="mb-2 px-1">
				<button
					type="button"
					aria-expanded={expanded}
					disabled={filter === "ended"}
					onClick={() => setOpen((current) => !current)}
					className="flex items-center gap-1 rounded text-sm font-semibold text-neutral-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600"
				>
					<ChevronDown aria-hidden className={cn("h-4 w-4 transition-transform", !expanded && "-rotate-90")} />
					Cancelled and expired <span className="font-normal text-neutral-500">{items.length}</span>
				</button>
			</h2>
			{expanded && (
				<ul className="divide-y divide-neutral-100 overflow-hidden rounded-3xl bg-white">
					{items.map((item) => (
						<SubscriptionRow key={item.id} item={item} {...rowProps} />
					))}
				</ul>
			)}
		</section>
	);
}

function SubscriptionSections({
	items,
	groups,
	filter,
	rowProps,
}: {
	items: SubscriptionItem[];
	groups: SubscriptionGroups;
	filter: StatusFilter;
	rowProps: RowProps;
}) {
	const shown = visibleSections(filter);
	const currentCount = groups.attention.length + groups.upcoming.length + groups.noDate.length;
	return (
		<>
			{shown.current && groups.attention.length > 0 && (
				<Section id="attention" title="Needs attention" count={groups.attention.length}>
					{groups.attention.map(({ item, reason }) => (
						<SubscriptionRow key={item.id} item={item} reason={reason} {...rowProps} />
					))}
				</Section>
			)}
			{shown.current && groups.upcoming.length > 0 && (
				<Section id="upcoming" title="Upcoming renewals" count={groups.upcoming.length}>
					{groups.upcoming.map((item) => (
						<SubscriptionRow key={item.id} item={item} {...rowProps} />
					))}
				</Section>
			)}
			{shown.current && groups.noDate.length > 0 && (
				<Section id="no-date" title="No date" count={groups.noDate.length}>
					{groups.noDate.map((item) => (
						<SubscriptionRow key={item.id} item={item} {...rowProps} />
					))}
				</Section>
			)}
			{filter === "current" && currentCount === 0 && items.length > 0 && (
				<p className="text-sm text-neutral-600">No active subscriptions or trials.</p>
			)}
			{shown.ended && <EndedSection items={groups.ended} filter={filter} rowProps={rowProps} />}
			{filter === "ended" && groups.ended.length === 0 && items.length > 0 && (
				<p className="text-sm text-neutral-600">No cancelled or expired subscriptions.</p>
			)}
		</>
	);
}

/** The Subscriptions page: totals, Needs attention, upcoming renewals, rows without a date and ended rows. */
export function SubscriptionsView() {
	const router = useRouter();
	const params = useSearchParams();
	const openId = params.get("subscription");
	const adding = params.get("add") === "1";
	const { list, error, version, reload } = useSubscriptionList();
	const drawer = useSubscriptionDetail(openId, version);
	const [filter, setFilter] = useState<StatusFilter>("all");
	// undefined: closed; null: adding a new row; a row: editing it.
	const [editing, setEditing] = useState<SubscriptionItem | null | undefined>(undefined);
	const [today] = useState(viewerToday);
	const [locale] = useState(viewerLocale);

	const items = list?.subscriptions ?? [];
	const groups = groupSubscriptions(items, today);
	const dialogOpen = adding || editing !== undefined;
	const rowProps = {
		today,
		locale,
		onOpen: (id: string) => router.push(`/finance?subscription=${encodeURIComponent(id)}`, { scroll: false }),
		onEdit: (item: SubscriptionItem) => setEditing(item),
		onChanged: reload,
	};

	return (
		<div className="mx-auto w-full max-w-4xl space-y-6 px-4 py-6 md:px-8" data-finance-page>
			<header className="flex flex-wrap items-center gap-3">
				<WalletCards className="size-6 text-blue-600" aria-hidden />
				<h1 className="mr-auto text-2xl font-semibold text-neutral-900 md:text-3xl">Subscriptions</h1>
				<Select
					aria-label="Show"
					containerClassName="flex h-9 text-sm"
					value={filter}
					onChange={(event) => setFilter(event.target.value as StatusFilter)}
				>
					{FILTERS.map((option) => (
						<option key={option.value} value={option.value}>
							{option.label}
						</option>
					))}
				</Select>
				<Button type="button" className={mobilePrimaryActionClass} onClick={() => setEditing(null)}>
					<Plus aria-hidden className="h-4 w-4" />
					Add subscription
				</Button>
			</header>

			{error && (
				<p role="alert" className="text-sm text-red-600">
					{error}
				</p>
			)}
			{list?.migrationPending && (
				<p className="rounded-3xl bg-white p-5 text-sm text-neutral-600">
					The database update for Money Watch has not been applied yet.
				</p>
			)}
			{list && !list.migrationPending && (
				<>
					<SubscriptionTotals totals={list.totals} items={items} locale={locale} />
					{items.length === 0 && (
						<p className="rounded-3xl bg-white p-6 text-sm text-neutral-600">
							Money Watch lists the subscriptions you track here, with their renewals and documents. Track one from a
							receipt, or add it by hand.
						</p>
					)}
					<SubscriptionSections items={items} groups={groups} filter={filter} rowProps={rowProps} />
				</>
			)}

			<SubscriptionDrawer
				state={drawer}
				today={today}
				locale={locale}
				onClose={() => router.replace("/finance", { scroll: false })}
				onEdit={(item) => setEditing(item)}
				onChanged={reload}
			/>
			<SubscriptionDialog
				item={adding ? null : (editing ?? null)}
				open={dialogOpen}
				onOpenChange={(open) => {
					if (open) return;
					setEditing(undefined);
					if (adding) router.replace(openId ? `/finance?subscription=${encodeURIComponent(openId)}` : "/finance");
				}}
				onChanged={reload}
			/>
		</div>
	);
}
