"use client";

import * as Popover from "@radix-ui/react-popover";
import { useState } from "react";
import { Archive, Clock, Mail, MailOpen, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { MessageListRowActionsProps } from "./types";
import { isMessageSnoozed, unsnoozeMessage } from "./message-list-row-actions-utils";
import { SnoozePicker } from "./snooze-picker";
import { reportListActionError } from "./list-action-toast";

export function MessageListRowActions({ message, onAction, compact = false, star }: MessageListRowActionsProps) {
	const [snoozeOpen, setSnoozeOpen] = useState(false);
	const snoozed = isMessageSnoozed(message.snoozedUntil);
	const readAction = message.read ? "unread" : "read";
	const buttonClassName = compact ? "h-[22px] w-6 rounded p-0" : undefined;

	return (
		<>
			<div
				className={`absolute z-10 flex items-center gap-1 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100 group-has-[:focus-visible]:pointer-events-auto group-has-[:focus-visible]:opacity-100 ${snoozeOpen ? "pointer-events-auto opacity-100" : "pointer-events-none opacity-0"} ${compact ? "-right-1 -top-1.5 h-6 gap-0 rounded-md border border-neutral-200 bg-white shadow-sm" : "right-6 top-1/2 -translate-y-1/2 bg-[#f2f6fc] pl-3"}`}
			>
				{star && (
					// One name in both states, so the pressed state carries it ("Star", pressed); the tooltip says what a click does.
					<Tooltip label={star.starred ? "Unstar" : "Star"}>
						<Button
							type="button"
							variant="ghost"
							size="sm"
							className={buttonClassName}
							onClick={star.onToggle}
							aria-label="Star"
							aria-pressed={star.starred}
						>
							<star.icon className={cn("h-4 w-4", star.starred && "fill-amber-400 text-amber-400")} />
						</Button>
					</Tooltip>
				)}
				<Tooltip label="Archive">
					<Button
						type="button"
						variant="ghost"
						size="sm"
						className={buttonClassName}
						onClick={() => void onAction("archive")}
						aria-label="Archive"
					>
						<Archive className="h-4 w-4" />
					</Button>
				</Tooltip>
				<Tooltip label="Trash">
					<Button
						type="button"
						variant="ghost"
						size="sm"
						className={buttonClassName}
						onClick={() => void onAction("trash")}
						aria-label="Trash"
					>
						<Trash2 className="h-4 w-4" />
					</Button>
				</Tooltip>
				<Tooltip label={readAction === "read" ? "Mark as read" : "Mark as unread"}>
					<Button
						type="button"
						variant="ghost"
						size="sm"
						className={buttonClassName}
						onClick={() => void onAction(readAction)}
						aria-label={readAction === "read" ? "Mark as read" : "Mark as unread"}
					>
						{readAction === "read" ? <MailOpen className="h-4 w-4" /> : <Mail className="h-4 w-4" />}
					</Button>
				</Tooltip>
				{snoozed ? (
					<Tooltip label="Unsnooze">
						<Button
							type="button"
							variant="ghost"
							size="sm"
							className={buttonClassName}
							onClick={() => void unsnoozeMessage(message.id).catch(reportListActionError)}
							aria-label="Unsnooze"
						>
							<Clock className="h-4 w-4" />
						</Button>
					</Tooltip>
				) : (
					<Popover.Root open={snoozeOpen} onOpenChange={setSnoozeOpen}>
						<Tooltip label={snoozeOpen ? null : "Snooze"}>
							<Popover.Trigger asChild>
								<Button type="button" variant="ghost" size="sm" className={buttonClassName} aria-label="Snooze">
									<Clock className="h-4 w-4" />
								</Button>
							</Popover.Trigger>
						</Tooltip>
						<Popover.Portal>
							<Popover.Content
								align="end"
								sideOffset={6}
								collisionPadding={8}
								aria-label="Snooze"
								className="z-50 w-72 rounded-xl border border-neutral-200 bg-white p-2 shadow-lg"
							>
								<SnoozePicker messageId={message.id} onSnoozed={() => setSnoozeOpen(false)} />
							</Popover.Content>
						</Popover.Portal>
					</Popover.Root>
				)}
			</div>
		</>
	);
}
