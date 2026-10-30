"use client";

import clsx from "clsx";
import Link from "next/link";
import { Archive, Mail, MailOpen } from "lucide-react";
import { ContactAvatar } from "@/components/contacts/contact-avatar";
import { Checkbox } from "@/components/ui/checkbox";
import { ScreenerRowControls } from "@/components/screener/screener-row-controls";
import { splitEmailAddressList } from "@/lib/email/address";
import { setMessageDragData } from "@/lib/messages/drag-utils";
import { MessageListRowActions } from "./message-list-row-actions";
import { MessageNavigationProgress } from "./message-navigation";
import { rowCheckboxHandlers } from "./message-range-selection-utils";
import { SendStateBadge } from "./send-state-badge";
import {
	AttachmentIndicator,
	MessageRowBadges,
	MessageRowParty,
	MessageRowPreview,
	MessageRowStar,
	UnreadDot,
} from "./message-row-parts";
import { getStackedRowDensity, getWideRowDensity } from "./reading-layout-utils";
import { SwipeableRow } from "./swipeable-row";
import type { MessageListRowProps } from "./types";
import { useMessageListRow } from "./use-message-list-row";
import { formatMessageListTimestamp, getMessagePartyClassName } from "./utils";

type RowState = ReturnType<typeof useMessageListRow>;
type RowViewProps = MessageListRowProps & { row: RowState };

function dragHandlers(row: RowState, dragMessageIds: string[]) {
	return {
		draggable: row.draggable,
		onDragStart: (event: React.DragEvent) => {
			if (row.draggable) setMessageDragData(event.dataTransfer, { messageIds: dragMessageIds });
		},
	};
}

function rowCheckboxLabel({ config, row }: Pick<RowViewProps, "config" | "row">) {
	return config.folder === "drafts"
		? `Select draft ${row.rowMessage.subject ?? "(no subject)"}`
		: `Select message from ${row.party}`;
}

/** The address whose avatar a row shows: the first recipient in Sent, otherwise the sender. */
function rowAvatarAddress(message: RowViewProps["message"], folder: string) {
	return folder === "sent" ? (splitEmailAddressList(message.toAddr)[0] ?? message.toAddr) : message.fromAddr;
}

/** The avatar with its unread dot, which the selection checkbox replaces while selecting. */
function RowAvatar({ showCheckbox, ...props }: RowViewProps & { showCheckbox: boolean }) {
	const { message, config, selected, row } = props;
	return (
		<span className="relative h-9 w-9 self-start">
			<ContactAvatar
				mailboxId={message.mailboxId}
				address={rowAvatarAddress(row.rowMessage, config.folder)}
				name={row.party}
				hasManagedAvatar={config.folder !== "sent" && message.fromContactHasAvatar}
				className={clsx("h-9 w-9 text-sm", showCheckbox && "opacity-0", "group-has-[:focus-visible]:opacity-0")}
			/>
			{row.unread && !showCheckbox && (
				<span
					aria-hidden="true"
					className="absolute bottom-0 right-0 h-2.5 w-2.5 rounded-full bg-blue-500 ring-2 ring-[var(--color-white)]"
				/>
			)}
			<span
				className={clsx(
					"absolute inset-0 flex items-center justify-center",
					!showCheckbox && "opacity-0",
					"group-has-[:focus-visible]:opacity-100",
				)}
			>
				<Checkbox
					checked={selected}
					{...rowCheckboxHandlers(message.id, props.onSelectedChange)}
					aria-label={rowCheckboxLabel(props)}
				/>
			</span>
		</span>
	);
}

/** The star in the row's bottom corner: shown when starred, on hover and with keyboard focus. */
function RowCornerStar({
	row,
	icon,
	hoverActions,
}: {
	row: RowState;
	icon: MessageListRowProps["config"]["icon"];
	hoverActions: boolean;
}) {
	if (!row.starToggle) return null;
	const Icon = icon;
	// With hover actions the toggle lives in their pill; the corner then only marks a starred row at rest.
	if (hoverActions)
		return row.starred ? (
			<span
				aria-hidden="true"
				className="absolute bottom-1 right-1 group-hover:hidden group-has-[:focus-visible]:hidden"
			>
				<Icon className="h-3.5 w-3.5 fill-amber-400 text-amber-400" />
			</span>
		) : null;
	return (
		<span
			className={clsx(
				"absolute bottom-0 right-0",
				!row.starred && "opacity-0 group-hover:opacity-100 group-has-[:focus-visible]:opacity-100",
			)}
		>
			<MessageRowStar starred={row.starred} compact icon={icon} onToggle={row.toggleStar} />
		</span>
	);
}

/**
 * The second line of a stacked row: the subject, then the badges, a starred row's star and the mailbox label
 * flush right under the date.
 */
function StackedSubjectLine({ inlineStar, ...props }: RowViewProps & { inlineStar: boolean }) {
	const { config, row } = props;
	const Icon = config.icon;
	return (
		<span className="mt-0.5 flex items-center gap-2">
			<span
				dir="auto"
				className={clsx(
					"reading-font min-w-0 flex-1 truncate text-sm",
					// Keeps a few letters of the subject when the pill is wide: the pill shortens first.
					props.mailboxLabel && "min-w-[4.5rem]",
					row.unread ? "text-neutral-700" : "text-neutral-500",
				)}
			>
				{row.rowMessage.subject ?? "(no subject)"}
			</span>
			<SendStateBadge message={row.rowMessage} />
			<MessageRowBadges message={row.rowMessage} folder={config.folder} />
			{inlineStar && row.starToggle && row.starred && (
				<Icon
					aria-hidden="true"
					className="h-3.5 w-3.5 shrink-0 fill-amber-400 text-amber-400 group-hover:hidden group-has-[:focus-visible]:hidden"
				/>
			)}
			{props.mailboxLabel}
			{row.starToggle && !inlineStar && <span className="w-5 shrink-0" />}
		</span>
	);
}

/**
 * The row of the list beside a reading pane (and on phones), after Zero's: a round avatar carrying the unread
 * dot, the sender with the conversation count and the date, the subject as a muted second line and the badges
 * as small icons. The checkbox takes the avatar's place while selecting; it stays in the tab order and shows
 * when focused.
 */
function StackedMessageRow(props: RowViewProps) {
	const { message, config, selected, active = false, density = "default", hoverActions = true, row } = props;
	const stackedDensity = getStackedRowDensity(density);
	const showHoverActions = row.hasRowActions && hoverActions;
	const showCheckbox = props.selecting || selected;
	const Icon = config.icon;
	// With a mailbox label the pill sits flush right under the date, so a starred row's star moves in front of
	// it instead of into the corner (where it would cover the pill). Without hover actions (phones) the star is
	// a tap target in the corner, which keeps its own slot.
	const inlineStar = Boolean(props.mailboxLabel) && showHoverActions;
	return (
		<div
			data-message-row={message.id}
			role={row.hasRowActions ? undefined : "listitem"}
			className={clsx(
				"group relative mx-2 grid grid-cols-[36px_minmax(0,1fr)] items-center gap-x-3 rounded-lg px-3 transition-colors",
				stackedDensity.rowClassName,
				active || selected ? "bg-neutral-100" : "hover:bg-neutral-100/60",
				row.draggable && "cursor-grab active:cursor-grabbing",
			)}
			{...dragHandlers(row, props.dragMessageIds)}
		>
			<MessageNavigationProgress progress={row.navigation.progress} />
			<RowAvatar {...props} showCheckbox={showCheckbox} />
			<div className="relative min-w-0">
				<Link
					href={row.href}
					onClick={row.onNavigate}
					onMouseDown={row.onMouseDown}
					aria-current={active ? "true" : undefined}
					className="block min-w-0 rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600"
				>
					<span
						className={clsx(
							"flex items-baseline justify-between gap-3",
							showHoverActions && "group-hover:pr-[9.25rem] group-has-[:focus-visible]:pr-[9.25rem]",
						)}
					>
						<MessageRowParty
							party={row.party}
							unread={row.unread}
							threadCount={message.threadCount}
							suggestions={message.agentSuggestions}
							className={clsx("min-w-0 truncate text-sm", getMessagePartyClassName(row.rowMessage, config.folder))}
							countClassName="font-normal"
						/>
						<span
							className={clsx(
								"flex shrink-0 items-baseline gap-1.5",
								showHoverActions && "group-hover:hidden group-has-[:focus-visible]:hidden",
							)}
						>
							<AttachmentIndicator message={message} />
							<time dateTime={message.createdAt} className="text-xs text-neutral-500">
								{formatMessageListTimestamp(message.createdAt)}
							</time>
						</span>
					</span>
					<StackedSubjectLine {...props} inlineStar={inlineStar} />
					{/* A one-line summary shows even where the density leaves the plain preview out: it is the row's gist. */}
					{(stackedDensity.showPreview || row.line) && (
						<span dir="auto" className="reading-font mt-0.5 block truncate text-xs text-neutral-500">
							<MessageRowPreview preview={row.preview} line={row.line} />
						</span>
					)}
				</Link>
				{!inlineStar && <RowCornerStar row={row} icon={Icon} hoverActions={showHoverActions} />}
				<ScreenerRowControls message={row.rowMessage} compact />
				{showHoverActions && (
					<MessageListRowActions
						message={row.rowMessage}
						onAction={row.runRowAction}
						compact
						star={row.starToggle ? { starred: row.starred, icon: Icon, onToggle: row.toggleStar } : undefined}
					/>
				)}
			</div>
		</div>
	);
}

/** The single-line row of a full-width list. */
function WideMessageRow(props: RowViewProps) {
	const { message, config, selected, active = false, density = "default", row } = props;
	const Icon = config.icon;
	return (
		<div
			data-message-row={message.id}
			role="listitem"
			className={clsx(
				"group relative mx-2 grid grid-cols-[24px_32px_28px_minmax(140px,240px)_1fr_auto] items-center gap-3 rounded-lg px-4 text-left text-sm hover:z-10 hover:bg-neutral-100/70 has-[a:focus-visible]:ring-2 has-[a:focus-visible]:ring-inset has-[a:focus-visible]:ring-blue-600",
				getWideRowDensity(density).rowClassName,
				(active || selected) && "bg-blue-50 hover:bg-blue-50",
				row.draggable && "cursor-grab active:cursor-grabbing",
			)}
			{...dragHandlers(row, props.dragMessageIds)}
		>
			<MessageNavigationProgress progress={row.navigation.progress} />
			<Checkbox
				checked={selected}
				{...rowCheckboxHandlers(message.id, props.onSelectedChange)}
				// As in the stacked rows, checkboxes show while selecting, on hover and with keyboard focus.
				className={clsx(
					"relative z-10",
					!props.selecting && !selected && "opacity-0 group-hover:opacity-100 focus-visible:opacity-100",
				)}
				aria-label={rowCheckboxLabel(props)}
			/>
			{row.starToggle ? (
				<MessageRowStar starred={row.starred} compact={false} icon={Icon} onToggle={row.toggleStar} />
			) : (
				<Icon className="h-4 w-4 text-neutral-300" />
			)}
			<ContactAvatar
				mailboxId={message.mailboxId}
				address={rowAvatarAddress(row.rowMessage, config.folder)}
				name={row.party}
				hasManagedAvatar={config.folder !== "sent" && message.fromContactHasAvatar}
				className="h-7 w-7 text-xs"
			/>
			<span className="flex min-w-0 items-center gap-1.5">
				<MessageRowParty
					party={row.party}
					unread={row.unread}
					threadCount={message.threadCount}
					suggestions={message.agentSuggestions}
					className={getMessagePartyClassName(row.rowMessage, config.folder)}
					countClassName=""
				/>
				<UnreadDot unread={row.unread} />
			</span>
			<span className="flex min-w-0 items-center gap-2 text-neutral-700">
				{/* The overlay stretches the link over the whole row, so a click anywhere opens the message
				while the row has one keyboard stop; the checkbox, star and hover actions sit above it. */}
				<span className="min-w-[4.5rem] flex-1 truncate">
					<ScreenerRowControls message={row.rowMessage} />
					<Link
						href={row.href}
						onClick={config.folder === "drafts" ? row.onSelectClick : row.onNavigate}
						onMouseDown={row.onMouseDown}
						aria-current={active ? "true" : undefined}
						className="after:absolute after:inset-0 focus-visible:outline-none"
					>
						<span dir="auto" className={clsx("reading-font", row.unread && "font-medium text-neutral-900")}>
							{row.rowMessage.subject ?? "(no subject)"}
						</span>
						<span dir="auto" className="reading-font text-neutral-500">
							{" "}
							- <MessageRowPreview preview={row.preview} line={row.line} />
						</span>
					</Link>
				</span>
				<SendStateBadge message={row.rowMessage} />
				{props.mailboxLabel}
			</span>
			<span className="flex min-w-[96px] items-baseline justify-end gap-1.5 group-hover:opacity-0">
				<AttachmentIndicator message={message} />
				<time
					dateTime={message.createdAt}
					className={clsx(
						"whitespace-nowrap text-right text-xs",
						row.unread ? "font-medium text-neutral-900" : "text-neutral-500",
					)}
				>
					{formatMessageListTimestamp(message.createdAt)}
				</time>
			</span>
			{row.hasRowActions && <MessageListRowActions message={row.rowMessage} onAction={row.runRowAction} />}
		</div>
	);
}

/** One message (or conversation) in a folder list; in the stacked list a swipe marks it read or archives it. */
export function MessageListRow(props: MessageListRowProps) {
	const row = useMessageListRow(props);
	const { compact = false, config } = props;
	if (!compact || config.folder === "drafts") return <WideMessageRow {...props} row={row} />;
	const stacked = <StackedMessageRow {...props} row={row} />;
	if (!row.hasRowActions) return stacked;
	return (
		<SwipeableRow
			role="listitem"
			startAction={{
				label: row.read ? "Mark unread" : "Mark read",
				icon: row.read ? Mail : MailOpen,
				className: "bg-blue-600",
				onTrigger: () => void row.runRowAction(row.read ? "unread" : "read"),
			}}
			endAction={{
				label: "Archive",
				icon: Archive,
				className: "bg-emerald-600",
				onTrigger: () => void row.runRowAction("archive"),
			}}
		>
			{stacked}
		</SwipeableRow>
	);
}
