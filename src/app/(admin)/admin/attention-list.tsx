"use client";

import Link from "next/link";
import { CheckCircle2 } from "lucide-react";
import { Notice } from "@/components/ui/notice";
import { Skeleton } from "@/components/ui/skeleton";
import type { AttentionItem } from "./overview-types";

/** Jumps to a card on this page, or opens another admin page. */
function ItemLink({ item }: { item: AttentionItem }) {
	if (!item.hrefLabel) return null;
	const className = "text-sm font-medium underline underline-offset-2 hover:opacity-80";
	return item.href.startsWith("#") ? (
		<a href={item.href} className={className}>
			{item.hrefLabel}
		</a>
	) : (
		<Link href={item.href} className={className}>
			{item.hrefLabel}
		</Link>
	);
}

/** What needs attention, or that nothing does. */
export function AttentionList({ items, loading }: { items: AttentionItem[]; loading: boolean }) {
	return (
		<section aria-labelledby="needs-attention" className="space-y-2">
			<h2 id="needs-attention" className="text-base font-semibold text-neutral-900">
				Needs attention
			</h2>
			{loading && <Skeleton className="h-12 w-full rounded-xl" />}
			{!loading && items.length === 0 && (
				<p
					role="status"
					data-testid="all-clear"
					className="flex items-center gap-2 rounded-xl border border-neutral-200 bg-white px-4 py-3 text-sm text-neutral-700"
				>
					<CheckCircle2 className="h-4 w-4 text-green-600" aria-hidden="true" />
					Nothing needs your attention.
				</p>
			)}
			{items.map((item) => (
				<Notice
					key={item.id}
					tone={item.tone}
					title={item.title}
					actions={<ItemLink item={item} />}
					data-testid={`attention-${item.id}`}
				>
					{item.detail}
				</Notice>
			))}
		</section>
	);
}
