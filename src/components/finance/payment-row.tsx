"use client";

import Link from "next/link";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { MoreHorizontal, Sparkles, WalletCards } from "lucide-react";
import { useT } from "@/lib/i18n/use-t";
import { cn } from "@/lib/utils";
import type { PaymentItem, PaymentListStatus } from "./payments-types";
import { amountText, dayLabel, editable, mailHref, STATUS_LABELS, TYPE_LABELS } from "./payments-utils";
import { writeWithUndo } from "./subscription-writes";

const ITEM_CLASS =
	"flex cursor-pointer items-center gap-2 rounded-lg px-3 py-2 text-sm text-neutral-700 outline-none data-[disabled]:opacity-50 data-[highlighted]:bg-neutral-100";
const CONTENT_CLASS = "z-[130] min-w-52 rounded-xl border border-neutral-200 bg-white p-1 shadow-lg";

const STATUS_CLASS: Record<PaymentListStatus, string> = {
	open: "bg-amber-50 text-amber-800 ring-amber-200",
	paid: "bg-emerald-50 text-emerald-800 ring-emerald-200",
	refunded: "bg-blue-50 text-blue-800 ring-blue-200",
	credited: "bg-blue-50 text-blue-800 ring-blue-200",
	failed: "bg-red-50 text-red-800 ring-red-200",
};

export const paymentPath = (id: string) => `/api/finance/payments/${encodeURIComponent(id)}`;

type RowProps = {
	item: PaymentItem;
	locale: string | undefined;
	onCorrect: (item: PaymentItem) => void;
	onChanged: () => void;
};

function RowMenu({ item, onCorrect, onChanged }: Omit<RowProps, "locale">) {
	const t = useT();
	const href = mailHref(item);
	const invoice = item.docType === "invoice" && editable(item);
	const markAs = item.storedStatus === "open" ? "paid" : "open";
	return (
		<DropdownMenu.Root>
			<DropdownMenu.Trigger
				aria-label={t("Actions for {vendor}", { vendor: item.vendor })}
				className="flex items-center justify-center rounded-lg p-1.5 text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 pointer-coarse:h-11 pointer-coarse:w-11"
			>
				<MoreHorizontal aria-hidden className="h-4 w-4" />
			</DropdownMenu.Trigger>
			<DropdownMenu.Portal>
				<DropdownMenu.Content align="end" sideOffset={4} className={CONTENT_CLASS} data-payment-menu>
					{href && (
						<DropdownMenu.Item asChild className={ITEM_CLASS}>
							<Link href={href}>{t("Open mail")}</Link>
						</DropdownMenu.Item>
					)}
					{item.subscriptionId && (
						<DropdownMenu.Item asChild className={ITEM_CLASS}>
							<Link href={`/finance?subscription=${encodeURIComponent(item.subscriptionId)}`}>
								{t("Open subscription")}
							</Link>
						</DropdownMenu.Item>
					)}
					{invoice && (
						<DropdownMenu.Item
							className={ITEM_CLASS}
							onSelect={() =>
								void writeWithUndo(
									{ path: paymentPath(item.id), method: "PATCH", body: { fields: { status: markAs } } },
									markAs === "paid" ? t("Marked as paid") : t("Marked as open"),
									onChanged,
								)
							}
						>
							{markAs === "paid" ? t("Mark as paid") : t("Mark as open")}
						</DropdownMenu.Item>
					)}
					{editable(item) && (
						<>
							<DropdownMenu.Item className={ITEM_CLASS} onSelect={() => onCorrect(item)}>
								{t("Correct…")}
							</DropdownMenu.Item>
							<DropdownMenu.Separator className="my-1 h-px bg-neutral-100" />
							<DropdownMenu.Item
								className={cn(ITEM_CLASS, "text-red-700")}
								onSelect={() =>
									void writeWithUndo(
										{ path: paymentPath(item.id), method: "DELETE" },
										t("Removed {vendor}", { vendor: item.vendor }),
										onChanged,
									)
								}
							>
								{t("Remove")}
							</DropdownMenu.Item>
						</>
					)}
				</DropdownMenu.Content>
			</DropdownMenu.Portal>
		</DropdownMenu.Root>
	);
}

/** One payment or subscription document: date, vendor, type, status chip and amount, with its menu. */
export function PaymentRow({ item, locale, onCorrect, onChanged }: RowProps) {
	const t = useT();
	const amount = amountText(item, locale);
	const assisted = item.modelFields.length > 0;
	return (
		<li className="flex items-center gap-3 px-4 py-3" data-payment-row={item.id} data-payment-status={item.status}>
			<div className="min-w-0 flex-1">
				<div className="flex flex-wrap items-center gap-x-2 gap-y-1">
					<span className="truncate text-sm font-medium text-neutral-900" dir="auto">
						{item.vendor || t("Unknown vendor")}
					</span>
					<span
						className={cn("rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset", STATUS_CLASS[item.status])}
						data-payment-status-chip
					>
						{t(STATUS_LABELS[item.status])}
					</span>
					{item.subscriptionId && (
						<span
							className="inline-flex items-center gap-1 rounded-full bg-neutral-100 px-2 py-0.5 text-xs text-neutral-700"
							data-payment-subscription
						>
							<WalletCards aria-hidden className="h-3 w-3" />
							{t("Subscription")}
						</span>
					)}
					{assisted && (
						<span
							className="inline-flex items-center gap-1 text-xs text-neutral-500"
							title={t("Some values were read by the assistant")}
							data-payment-assisted
						>
							<Sparkles aria-hidden className="h-3 w-3" />
							{t("read by the assistant")}
						</span>
					)}
				</div>
				<p className="mt-0.5 text-xs text-neutral-500">
					{t(TYPE_LABELS[item.docType])} · {dayLabel(item.documentOn, locale)}
					{item.sender && (
						<>
							{" · "}
							<span dir="ltr" data-payment-sender>
								{item.sender}
							</span>
						</>
					)}
					{!item.message || item.message.unavailable ? ` · ${t("Message deleted")}` : ""}
				</p>
			</div>
			<span className="shrink-0 text-sm font-medium tabular-nums text-neutral-900" dir="ltr" data-payment-amount>
				{amount ?? "—"}
			</span>
			<RowMenu item={item} onCorrect={onCorrect} onChanged={onChanged} />
		</li>
	);
}
