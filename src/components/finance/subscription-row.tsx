"use client";

import Link from "next/link";
import { useState } from "react";
import { ExternalLink } from "lucide-react";
import { linkHost } from "./dialog-utils";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { SubscriptionRowMenu } from "./subscription-row-menu";
import { subscriptionPath, writeWithUndo } from "./subscription-writes";
import type { SubscriptionItem } from "./subscriptions-types";
import {
	cancelBeforeText,
	dueText,
	latestMessageHref,
	priceChangeChip,
	priceLabel,
	statusLabel,
} from "./subscriptions-utils";

const STATUS_CHIP: Record<SubscriptionItem["status"], string> = {
	active: "bg-blue-50 text-blue-700",
	trial: "bg-amber-50 text-amber-800",
	cancelled: "bg-neutral-100 text-neutral-600",
	expired: "bg-neutral-100 text-neutral-600",
};

/** Opens the stored https cancel link in a new tab, never fetched by Kite, like the reader's unsubscribe button. */
function openCancelUrl(url: string) {
	window.open(url, "_blank", "noopener,noreferrer");
}

const CHIP = "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium";

type RowProps = {
	item: SubscriptionItem;
	today: string;
	locale: string;
	/** Why the row needs attention, when it is in that section. */
	reason?: string;
	onOpen: (id: string) => void;
	onEdit: (item: SubscriptionItem) => void;
	onChanged: () => void;
};

/** "Cancel before …" or "Open latest message", and after the click "Did you cancel? Mark as cancelled". */
function CancelAction({
	item,
	prompted,
	onCancelLink,
	onChanged,
}: {
	item: SubscriptionItem;
	prompted: boolean;
	onCancelLink: () => void;
	onChanged: () => void;
}) {
	if (item.status !== "active" && item.status !== "trial") return null;
	if (prompted)
		return (
			<span className="flex flex-wrap items-center gap-2 text-xs text-neutral-600" data-finance-cancel-prompt>
				Did you cancel?
				<Button
					type="button"
					size="sm"
					variant="outline"
					onClick={() =>
						void writeWithUndo(
							{ path: subscriptionPath(item.id), method: "PATCH", body: { status: "cancelled" } },
							"Marked as cancelled",
							onChanged,
						)
					}
				>
					Mark as cancelled
				</Button>
			</span>
		);
	if (item.cancelUrl)
		return (
			<span className="flex flex-col items-end gap-0.5">
				<Button type="button" size="sm" variant="outline" onClick={onCancelLink} data-finance-cancel-button>
					{cancelBeforeText(item)}
					<ExternalLink aria-hidden className="h-3.5 w-3.5" />
				</Button>
				<span className="text-xs text-neutral-500">Opens {linkHost(item.cancelUrl)}</span>
			</span>
		);
	const latest = latestMessageHref(item);
	if (!latest) return null;
	return (
		<Button asChild size="sm" variant="ghost">
			<Link href={latest}>Open latest message</Link>
		</Button>
	);
}

/** One subscription: what it costs, when it is due, its flags, the cancel action and the row menu. */
export function SubscriptionRow({ item, today, locale, reason, onOpen, onEdit, onChanged }: RowProps) {
	const [prompted, setPrompted] = useState(false);
	const due = dueText(item, today);
	const chip = priceChangeChip(item, today, locale);
	function openCancelLink() {
		if (!item.cancelUrl) return;
		openCancelUrl(item.cancelUrl);
		setPrompted(true);
	}
	return (
		<li className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3" data-finance-row={item.id}>
			<button
				type="button"
				onClick={() => onOpen(item.id)}
				className="min-w-0 flex-1 basis-56 rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600"
			>
				<span className="flex min-w-0 flex-wrap items-baseline gap-x-2">
					<span className="truncate font-medium text-neutral-900">{item.vendor}</span>
					{item.plan && <span className="truncate text-sm text-neutral-500">{item.plan}</span>}
				</span>
				<span className="block text-sm text-neutral-600">
					{[priceLabel(item, locale), due].filter(Boolean).join(" · ")}
				</span>
				<span className="mt-1 flex flex-wrap gap-1.5">
					<span className={cn(CHIP, STATUS_CHIP[item.status])} data-finance-status>
						{statusLabel(item.status)}
					</span>
					{reason && <span className={cn(CHIP, "bg-red-50 text-red-700")}>{reason}</span>}
					{chip && (
						<span className={cn(CHIP, "bg-amber-50 text-amber-800")} data-finance-price-chip>
							{chip}
						</span>
					)}
					{item.renewalEstimated && item.nextRenewalOn && (
						<span
							className={cn(CHIP, "bg-neutral-100 text-neutral-600")}
							title="The renewal date was estimated from the cycle"
						>
							estimated
						</span>
					)}
				</span>
			</button>
			<div className="flex shrink-0 items-center gap-2">
				<CancelAction item={item} prompted={prompted} onCancelLink={openCancelLink} onChanged={onChanged} />
				<SubscriptionRowMenu
					item={item}
					onEdit={() => onEdit(item)}
					onCancelLink={openCancelLink}
					onChanged={onChanged}
				/>
			</div>
		</li>
	);
}
