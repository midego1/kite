"use client";

import * as Popover from "@radix-ui/react-popover";
import { Link2, MoreHorizontal } from "lucide-react";
import { useSelectedMailbox } from "@/components/mailbox-provider";
import { getMailboxAddress, getMailboxName } from "@/components/mailbox-selector-utils";
import { handOffMailSearch, useOptionalMailSearch } from "@/components/mail-search/mail-search-context";
import { LabelColorPicker } from "@/components/messages/label-color-picker";
import { LabelDot } from "@/components/messages/label-dot";
import { accountLabelColor } from "@/components/messages/label-colors-utils";
import { chooseLabelColor, useLabelColors, useMailboxLabelColor } from "@/components/messages/use-label-colors";
import { accountViewHref, type AccountViewEntry } from "@/lib/external-accounts/account-views-utils";
import { useStoredState } from "@/hooks/use-stored-state";
import { NavItem } from "./components-nav";
import { NavSectionHeader, useSectionOpen } from "./nav-section-header";

/** Set once the hint under the section header was dismissed or an account view was opened. */
const ACCOUNTS_HINT_KEY = "kite:nav:accounts-hint-seen";

/**
 * One account's row: the Inbox narrowed to its mail, with the account's icon in the colour chosen for it (the same
 * as its mark in the message list). The tooltip names the address the label stands for; the "⋯" button, on hover or
 * focus, opens the colour choice.
 */
function AccountViewItem({ entry, active, onOpen }: { entry: AccountViewEntry; active: boolean; onOpen: () => void }) {
	const search = useOptionalMailSearch();
	const colors = useLabelColors();
	const chosen = colors.accounts?.[entry.id];
	return (
		<div className="group/account relative" data-account-view={entry.id}>
			<NavItem
				link={{
					href: accountViewHref(entry),
					label: entry.label,
					title: `Shows only mail that came in through ${entry.address}. Nothing is moved.`,
					icon: Link2,
					iconColor: accountLabelColor(colors, entry.id) ?? undefined,
					active,
					// The mail search outlives page changes, so the click sets it; the address alone only seeds a fresh one.
					onSelect: () => {
						onOpen();
						handOffMailSearch("", entry.address);
						search?.setView(entry.address);
					},
				}}
			/>
			<Popover.Root>
				<Popover.Trigger asChild>
					<button
						type="button"
						aria-label={`Colour for ${entry.label}`}
						className="absolute end-1 top-1.5 flex h-6 w-6 items-center justify-center rounded-md bg-neutral-100 text-neutral-600 opacity-0 transition-opacity hover:bg-neutral-200 hover:text-neutral-900 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 group-hover/account:opacity-100 data-[state=open]:opacity-100 max-md:top-2.5 max-md:h-7 max-md:w-7"
					>
						<MoreHorizontal aria-hidden className="h-4 w-4" />
					</button>
				</Popover.Trigger>
				<Popover.Portal>
					<Popover.Content
						align="start"
						sideOffset={4}
						collisionPadding={8}
						aria-label={`Colour for ${entry.label}`}
						className="z-[130] w-56 rounded-xl border border-neutral-200 bg-white p-3 shadow-lg"
					>
						<p className="mb-2 text-xs font-semibold uppercase tracking-wide text-neutral-500">Icon colour</p>
						<LabelColorPicker
							label={`Colour for ${entry.label}`}
							value={chosen}
							defaultLabel="No colour"
							defaultGlyph="–"
							onChange={(color) => chooseLabelColor("accounts", entry.id, color)}
						/>
					</Popover.Content>
				</Popover.Portal>
			</Popover.Root>
		</div>
	);
}

/**
 * The connected accounts of the mailboxes in view, each a view of the Inbox with only the mail that came in through
 * it (`via:`), listed under the mailbox it delivers into in All mailboxes. Hidden when there are none and in the
 * icon rail.
 */
export function SidebarAccountViews({
	entries,
	active,
}: {
	entries: readonly AccountViewEntry[];
	active: AccountViewEntry | null;
}) {
	const { allMailboxes, viewMailboxes } = useSelectedMailbox();
	const colorOf = useMailboxLabelColor();
	const [open, toggle] = useSectionOpen("kite:nav:accounts-section-open");
	const [hintSeen, setHintSeen] = useStoredState(ACCOUNTS_HINT_KEY, false);
	if (entries.length === 0) return null;
	const groups = viewMailboxes
		.map((mailbox) => ({ mailbox, entries: entries.filter((entry) => entry.mailboxId === mailbox.id) }))
		.filter((group) => group.entries.length > 0);
	return (
		<>
			<NavSectionHeader label="Connected accounts" open={open} onToggle={toggle} />
			{open && !hintSeen && (
				<p data-accounts-hint className="mx-6 mb-0.5 text-xs leading-4 text-neutral-500">
					Each shows only the mail that came in through that account. Nothing is moved.{" "}
					<button
						type="button"
						onClick={() => setHintSeen(true)}
						className="font-medium text-neutral-700 underline hover:text-neutral-900"
					>
						Got it
					</button>
				</p>
			)}
			{open &&
				groups.map(({ mailbox, entries: group }) => (
					<div key={mailbox.id} role="group" aria-label={`${getMailboxName(mailbox)} connected accounts`}>
						{allMailboxes && (
							<p className="flex items-center gap-1.5 truncate px-6 pb-0.5 pt-2 text-xs font-medium text-neutral-500">
								<LabelDot color={colorOf({ id: mailbox.id, address: getMailboxAddress(mailbox) }).value} />
								<span className="truncate">{getMailboxName(mailbox)}</span>
							</p>
						)}
						{group.map((entry) => (
							<AccountViewItem
								key={entry.id}
								entry={entry}
								active={entry.id === active?.id}
								onOpen={() => setHintSeen(true)}
							/>
						))}
					</div>
				))}
		</>
	);
}
