"use client";

import Link from "next/link";
import { FileText, MessageSquare, Trash2 } from "lucide-react";
import { linkHost } from "./dialog-utils";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { shortDay } from "@/lib/finance/text-utils";
import { writeWithUndo } from "./subscription-writes";
import type { DocumentItem, DrawerState, SubscriptionDetail, SubscriptionItem } from "./subscriptions-types";
import {
	documentAmount,
	documentHref,
	documentLabel,
	dueText,
	messageGone,
	pairedLabel,
	paidLines,
	periodText,
	priceLabel,
	reminderLabel,
	statusLabel,
	threadHref,
} from "./subscriptions-utils";

type DrawerProps = {
	state: DrawerState;
	today: string;
	locale: string;
	onClose: () => void;
	onEdit: (item: SubscriptionItem) => void;
	onChanged: () => void;
};

const LINK_CLASS =
	"inline-flex items-center gap-1 rounded text-xs font-medium text-blue-700 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600";

function Field({ label, value }: { label: string; value: string }) {
	return (
		<div className="flex justify-between gap-4 py-1.5 text-sm">
			<dt className="text-neutral-500">{label}</dt>
			<dd className="min-w-0 break-words text-right text-neutral-900">{value}</dd>
		</div>
	);
}

function DocumentEntry({
	document,
	locale,
	onChanged,
}: {
	document: DocumentItem;
	locale: string;
	onChanged: () => void;
}) {
	const amount = documentAmount(document, locale);
	const period = periodText(document.periodStartOn, document.periodEndOn);
	const paired = pairedLabel(document);
	const thread = threadHref(document);
	const file = documentHref(document);
	return (
		<li className="space-y-1 px-3 py-2.5" data-finance-document={document.id}>
			<div className="flex items-start justify-between gap-3">
				<div className="min-w-0">
					<span className="font-medium text-neutral-900">{documentLabel(document.docType)}</span>
					{paired && (
						<span className="ml-2 rounded-full bg-blue-50 px-2 py-0.5 text-xs font-medium text-blue-700">{paired}</span>
					)}
					<span className="block text-xs text-neutral-500">
						{[document.documentOn && shortDay(document.documentOn), period].filter(Boolean).join(" · ")}
					</span>
				</div>
				<div className="flex shrink-0 items-center gap-1">
					{amount && <span className="text-sm tabular-nums text-neutral-900">{amount}</span>}
					<button
						type="button"
						aria-label={`Remove ${documentLabel(document.docType).toLowerCase()}`}
						className="rounded p-1 text-neutral-400 hover:bg-neutral-100 hover:text-red-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600"
						onClick={() =>
							void writeWithUndo(
								{ path: `/api/finance/documents/${encodeURIComponent(document.id)}`, method: "DELETE" },
								"Document removed",
								onChanged,
							)
						}
					>
						<Trash2 aria-hidden className="h-3.5 w-3.5" />
					</button>
				</div>
			</div>
			{messageGone(document) ? (
				<p className="text-xs text-neutral-500">Message deleted</p>
			) : (
				<div className="flex flex-wrap gap-3">
					{thread && (
						<Link href={thread} className={LINK_CLASS}>
							<MessageSquare aria-hidden className="h-3.5 w-3.5" />
							Open thread
						</Link>
					)}
					{file && (
						<a href={file} target="_blank" rel="noopener noreferrer" className={LINK_CLASS}>
							<FileText aria-hidden className="h-3.5 w-3.5" />
							Open document
						</a>
					)}
				</div>
			)}
		</li>
	);
}

function DrawerBody({
	detail,
	today,
	locale,
	onEdit,
	onChanged,
}: Omit<DrawerProps, "state" | "onClose"> & { detail: SubscriptionDetail }) {
	const { subscription: item, documents } = detail;
	const paid = paidLines(detail.paidLast12Months, locale);
	return (
		<div className="space-y-5">
			<dl className="divide-y divide-neutral-100">
				<Field label="Price" value={priceLabel(item, locale)} />
				<Field label="Status" value={statusLabel(item.status)} />
				{item.plan && <Field label="Plan" value={item.plan} />}
				<Field label="Due" value={dueText(item, today) ?? "No date"} />
				<Field
					label="Reminder"
					value={`${reminderLabel(item.reminderDays)}${item.calendarReminder ? ", in the calendar" : ""}`}
				/>
				<Field label="Cancel link" value={item.cancelUrl ? linkHost(item.cancelUrl) : "None"} />
			</dl>
			<section aria-labelledby="finance-drawer-paid" className="rounded-xl bg-neutral-50 p-3">
				<h3 id="finance-drawer-paid" className="text-xs font-medium text-neutral-500">
					Paid in the last 12 months
				</h3>
				{paid.length === 0 ? (
					<p className="text-sm text-neutral-700">Nothing recorded</p>
				) : (
					paid.map((line) => (
						<p
							key={line.currency}
							className="text-sm font-medium tabular-nums text-neutral-900"
							data-finance-drawer-paid
						>
							{line.text}
						</p>
					))
				)}
			</section>
			<section aria-labelledby="finance-drawer-documents">
				<h3 id="finance-drawer-documents" className="mb-2 text-sm font-semibold text-neutral-900">
					Documents
				</h3>
				{documents.length === 0 ? (
					<p className="text-sm text-neutral-500">No invoices, payments or refunds recorded yet.</p>
				) : (
					<ul className="divide-y divide-neutral-100 rounded-xl border border-neutral-200" data-finance-documents>
						{documents.map((document) => (
							<DocumentEntry key={document.id} document={document} locale={locale} onChanged={onChanged} />
						))}
					</ul>
				)}
			</section>
			<Button type="button" variant="outline" size="sm" onClick={() => onEdit(item)}>
				Edit
			</Button>
		</div>
	);
}

const DESCRIPTIONS: Record<DrawerState["kind"], string> = {
	closed: "",
	loading: "Its invoices, payments and refunds, newest first.",
	ready: "Its invoices, payments and refunds, newest first.",
	missing: "This subscription no longer exists.",
	"migration-pending": "The database update for Money Watch has not been applied yet.",
};

/** `/finance?subscription=<id>`: the fields, the 12-month paid total and the document history. */
export function SubscriptionDrawer({ state, today, locale, onClose, onEdit, onChanged }: DrawerProps) {
	return (
		<Dialog open={state.kind !== "closed"} onOpenChange={(open) => !open && onClose()}>
			<DialogContent
				data-finance-drawer
				data-finance-drawer-state={state.kind}
				className="bottom-0 left-auto right-0 top-0 h-full w-[min(440px,100vw)] max-w-full translate-x-0 translate-y-0 overflow-y-auto rounded-none rounded-l-2xl"
			>
				<DialogHeader>
					<DialogTitle className="pr-8">
						{state.kind === "ready" ? state.detail.subscription.vendor : "Subscription"}
					</DialogTitle>
					<DialogDescription>{DESCRIPTIONS[state.kind]}</DialogDescription>
				</DialogHeader>
				{state.kind === "ready" && (
					<DrawerBody detail={state.detail} today={today} locale={locale} onEdit={onEdit} onChanged={onChanged} />
				)}
				{state.kind === "loading" && <p className="text-sm text-neutral-500">Loading…</p>}
			</DialogContent>
		</Dialog>
	);
}
