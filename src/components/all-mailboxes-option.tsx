"use client";

import { Check, Inbox } from "lucide-react";
import { useSelectedMailbox } from "@/components/mailbox-provider";
import { Checkbox } from "@/components/ui/checkbox";
import { getMailboxAddress, getMailboxName } from "@/components/mailbox-selector-utils";
import { sumMailboxCounts, visibleMailboxIds } from "@/lib/mailboxes/scope-utils";
import type { MailboxCount } from "@/hooks/types";
import { cn } from "@/lib/utils";

/** The All mailboxes mark: the same footprint as a mailbox avatar. */
export function AllMailboxesIcon({ className }: { className?: string }) {
	return (
		<span
			className={cn(
				"flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-blue-100 text-blue-700",
				className,
			)}
			aria-hidden
		>
			<Inbox className="h-3.5 w-3.5" />
		</span>
	);
}

/** The first entry of the mailbox selector, offered once the user can open two or more mailboxes. */
export function AllMailboxesOption({ counts, onSelect }: { counts: MailboxCount[]; onSelect: () => void }) {
	const { mailboxes, allMailboxes } = useSelectedMailbox();
	if (mailboxes.length < 2) return null;
	const { unread } = sumMailboxCounts(
		counts,
		mailboxes.map((mailbox) => mailbox.id),
	);
	return (
		<button
			type="button"
			role="option"
			aria-selected={allMailboxes}
			onClick={onSelect}
			className={cn(
				"flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left hover:bg-neutral-100",
				allMailboxes && "bg-blue-50",
			)}
		>
			<AllMailboxesIcon className="h-7 w-7" />
			<span className="min-w-0 flex-1">
				<span className="block truncate text-sm font-medium text-neutral-900">All mailboxes</span>
				<span className="block truncate text-xs text-neutral-500">{mailboxes.length} mailboxes in one view</span>
			</span>
			{unread > 0 && (
				<span className="rounded-full bg-blue-100 px-1.5 py-0.5 text-[11px] font-semibold text-blue-700">
					{unread > 99 ? "99+" : unread}
				</span>
			)}
			{allMailboxes && <Check className="h-4 w-4 shrink-0 text-blue-600" />}
		</button>
	);
}

/**
 * Narrows the All mailboxes view to some mailboxes, remembered per browser. The filter stores the
 * hidden ones, so a new mailbox shows up by default; the last visible mailbox cannot be unchecked.
 */
export function AllMailboxesFilter() {
	const { mailboxes, allMailboxes, hiddenMailboxIds, setHiddenMailboxIds } = useSelectedMailbox();
	if (!allMailboxes) return null;
	const ids = mailboxes.map((mailbox) => mailbox.id);
	const visible = new Set(visibleMailboxIds(ids, hiddenMailboxIds));
	return (
		<fieldset className="mx-1 mb-1 rounded-lg border border-neutral-100 px-2 py-1.5" aria-label="Show in All mailboxes">
			<legend className="px-1 text-[11px] font-semibold uppercase tracking-wide text-neutral-500">Show</legend>
			{mailboxes.map((mailbox) => {
				const checked = visible.has(mailbox.id);
				const last = checked && visible.size === 1;
				return (
					<label
						key={mailbox.id}
						className="flex cursor-pointer items-center gap-2 rounded-md px-1 py-1 text-sm text-neutral-800 hover:bg-neutral-50"
						title={getMailboxAddress(mailbox)}
					>
						<Checkbox
							checked={checked}
							disabled={last}
							aria-label={`Show ${getMailboxAddress(mailbox)} in All mailboxes`}
							onChange={(event) => {
								setHiddenMailboxIds(ids.filter((id) => (id === mailbox.id ? !event.target.checked : !visible.has(id))));
							}}
						/>
						<span className="min-w-0 flex-1 truncate">{getMailboxName(mailbox)}</span>
					</label>
				);
			})}
		</fieldset>
	);
}
