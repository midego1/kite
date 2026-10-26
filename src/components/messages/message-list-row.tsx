"use client";

import clsx from "clsx";
import Link from "next/link";
import { Archive, Mail, MailOpen } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { ScreenerRowControls } from "@/components/screener/screener-row-controls";
import { setMessageDragData } from "@/lib/messages/drag-utils";
import { MessageListRowActions } from "./message-list-row-actions";
import { MessageNavigationProgress } from "./message-navigation";
import { rowCheckboxHandlers } from "./message-range-selection-utils";
import { MessageRowBadges, MessageRowParty, MessageRowStar, UnreadDot } from "./message-row-parts";
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

/** The row of the list beside a reading pane (and on phones): sender and date, subject, preview, badges. */
function StackedMessageRow(props: RowViewProps) {
	const { message, config, selected, active = false, density = "default", hoverActions = true, row } = props;
	const stackedDensity = getStackedRowDensity(density);
	const showHoverActions = row.hasRowActions && hoverActions;
	const Icon = config.icon;
	return (
		<div
			data-message-row={message.id}
			role={row.hasRowActions ? undefined : "listitem"}
			className={clsx(
				"group relative mx-2 grid grid-cols-[16px_minmax(0,1fr)] gap-x-3 rounded-lg px-3 transition-colors",
				stackedDensity.rowClassName,
				active ? "bg-blue-50 ring-1 ring-inset ring-blue-200" : selected ? "bg-neutral-100" : "hover:bg-neutral-50",
				row.draggable && "cursor-grab active:cursor-grabbing",
			)}
			{...dragHandlers(row, props.dragMessageIds)}
		>
			<MessageNavigationProgress progress={row.navigation.progress} />
			<span className="flex flex-col items-center gap-1.5 pt-0.5">
				<Checkbox
					checked={selected}
					{...rowCheckboxHandlers(message.id, props.onSelectedChange)}
					aria-label={rowCheckboxLabel(props)}
				/>
				{row.starToggle && <MessageRowStar starred={row.starred} compact icon={Icon} onToggle={row.toggleStar} />}
			</span>
			<div className="relative min-w-0">
				<Link
					href={row.href}
					onClick={row.onNavigate}
					aria-current={active ? "true" : undefined}
					className="block min-w-0 rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600"
				>
					<span
						className={clsx(
							"flex items-center justify-between gap-3",
							showHoverActions && "group-hover:pr-[6.75rem] group-has-[:focus-visible]:pr-[6.75rem]",
						)}
					>
						<span className="flex min-w-0 items-center gap-1.5">
							<UnreadDot unread={row.unread} />
							<MessageRowParty
								party={row.party}
								unread={row.unread}
								threadCount={message.threadCount}
								suggestions={message.agentSuggestions}
								className={clsx("min-w-0 truncate", getMessagePartyClassName(row.rowMessage, config.folder))}
								countClassName="font-normal"
							/>
						</span>
						<time
							dateTime={message.createdAt}
							className={clsx(
								row.unread ? "font-medium text-neutral-900" : "text-neutral-500",
								"shrink-0 text-[11px]",
								showHoverActions && "group-hover:hidden group-has-[:focus-visible]:hidden",
							)}
						>
							{formatMessageListTimestamp(message.createdAt)}
						</time>
					</span>
					<span
						dir="auto"
						className={clsx(
							"mt-0.5 block truncate pl-3.5 text-[13px]",
							row.unread ? "font-semibold text-neutral-900" : "text-neutral-700",
						)}
					>
						{row.rowMessage.subject ?? "(no subject)"}
					</span>
					{stackedDensity.showPreview && (
						<span dir="auto" className="mt-0.5 line-clamp-2 pl-3.5 text-xs leading-5 text-neutral-500">
							{row.preview}
						</span>
					)}
					<span className="block pl-3.5">
						<MessageRowBadges message={row.rowMessage} folder={config.folder} />
					</span>
				</Link>
				<ScreenerRowControls message={row.rowMessage} compact />
				{showHoverActions && <MessageListRowActions message={row.rowMessage} onAction={row.runRowAction} compact />}
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
				"group relative grid w-full grid-cols-[24px_32px_minmax(160px,260px)_1fr_auto] items-center gap-3 px-6 text-left text-sm hover:z-10 hover:bg-[#f2f6fc] hover:shadow-sm has-[a:focus-visible]:ring-2 has-[a:focus-visible]:ring-inset has-[a:focus-visible]:ring-blue-600",
				getWideRowDensity(density).rowClassName,
				(active || selected) && "bg-blue-50",
				row.draggable && "cursor-grab active:cursor-grabbing",
			)}
			{...dragHandlers(row, props.dragMessageIds)}
		>
			<MessageNavigationProgress progress={row.navigation.progress} />
			<Checkbox
				checked={selected}
				{...rowCheckboxHandlers(message.id, props.onSelectedChange)}
				className="relative z-10"
				aria-label={rowCheckboxLabel(props)}
			/>
			{row.starToggle ? (
				<MessageRowStar starred={row.starred} compact={false} icon={Icon} onToggle={row.toggleStar} />
			) : (
				<Icon className="h-4 w-4 text-neutral-300" />
			)}
			<span className="flex min-w-0 items-center gap-1.5">
				<UnreadDot unread={row.unread} />
				<MessageRowParty
					party={row.party}
					unread={row.unread}
					threadCount={message.threadCount}
					suggestions={message.agentSuggestions}
					className={getMessagePartyClassName(row.rowMessage, config.folder)}
					countClassName=""
				/>
			</span>
			<span className="truncate text-neutral-700">
				{/* The overlay stretches the link over the whole row, so a click anywhere opens the message
				while the row has one keyboard stop; the checkbox, star and hover actions sit above it. */}
				<ScreenerRowControls message={row.rowMessage} />
				<Link
					href={row.href}
					onClick={config.folder === "drafts" ? undefined : row.onNavigate}
					aria-current={active ? "true" : undefined}
					className="after:absolute after:inset-0 focus-visible:outline-none"
				>
					<span dir="auto" className={row.unread ? "font-semibold text-neutral-900" : ""}>
						{row.rowMessage.subject ?? "(no subject)"}
					</span>
					<span dir="auto" className="text-neutral-500">
						{" "}
						- {row.preview}
					</span>
				</Link>
			</span>
			<time
				dateTime={message.createdAt}
				className={clsx(
					"min-w-[96px] whitespace-nowrap text-right text-xs group-hover:opacity-0",
					row.unread ? "font-semibold text-neutral-800" : "text-neutral-500",
				)}
			>
				{formatMessageListTimestamp(message.createdAt)}
			</time>
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
