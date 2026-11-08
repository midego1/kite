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
import { useT } from "@/lib/i18n/use-t";

/**
 * On a fine pointer (a mouse) this pill only shows on hover or keyboard focus, floating over the row. A coarse
 * pointer (touch) never hovers, so there it drops the overlay and becomes a static, wrapped, always-visible
 * action bar under the row instead — the same actions, reachable without a mouse. `hoverReveal=false` keeps the
 * narrowest compact rows free of the hover pill even with a mouse, as before, while touch still gets the bar.
 */
export function MessageListRowActions({
	message,
	onAction,
	compact = false,
	star,
	hoverReveal = true,
}: MessageListRowActionsProps) {
	const t = useT();
	const [snoozeOpen, setSnoozeOpen] = useState(false);
	const snoozed = isMessageSnoozed(message.snoozedUntil);
	const readAction = message.read ? "unread" : "read";
	const buttonClassName = cn(
		"pointer-coarse:h-11 pointer-coarse:w-11",
		compact && "h-[22px] w-6 rounded p-0 pointer-coarse:rounded-lg",
	);

	return (
		<>
			<div
				className={cn(
					"flex flex-wrap items-center justify-end gap-1",
					// Fine pointer (a mouse): float over the row, hidden until hover or focus, unless `hoverReveal`
					// is off (the narrowest compact rows keep this out of the way even with a mouse).
					hoverReveal
						? cn(
								"pointer-fine:absolute pointer-fine:z-10 pointer-fine:transition-opacity",
								"pointer-fine:group-hover:pointer-events-auto pointer-fine:group-hover:opacity-100",
								"pointer-fine:group-has-[:focus-visible]:pointer-events-auto pointer-fine:group-has-[:focus-visible]:opacity-100",
								snoozeOpen
									? "pointer-fine:pointer-events-auto pointer-fine:opacity-100"
									: "pointer-fine:pointer-events-none pointer-fine:opacity-0",
								compact
									? "pointer-fine:-end-1 pointer-fine:-top-1.5 pointer-fine:h-6 pointer-fine:gap-0 pointer-fine:rounded-md pointer-fine:border pointer-fine:border-neutral-200 pointer-fine:bg-white pointer-fine:shadow-sm"
									: "pointer-fine:end-6 pointer-fine:top-1/2 pointer-fine:-translate-y-1/2 pointer-fine:bg-[#f2f6fc] pointer-fine:ps-3",
							)
						: "pointer-fine:hidden",
					// Coarse pointer (touch) never hovers, so it is always visible and tappable here, whatever
					// `hoverReveal` says. The stacked row is normal block flow, so it can safely drop the overlay
					// and flow in as its own wrapped, full-width line under the row. The wide row is a CSS grid,
					// where a stray extra item can land in the wrong cell, so it keeps the overlay position and
					// only grows the buttons and reveals it.
					compact
						? "pointer-coarse:static pointer-coarse:mt-1.5 pointer-coarse:w-full pointer-coarse:gap-1.5 pointer-coarse:rounded-lg pointer-coarse:border pointer-coarse:border-neutral-200 pointer-coarse:bg-white pointer-coarse:p-1 pointer-coarse:opacity-100 pointer-coarse:shadow-sm"
						: "absolute pointer-coarse:end-2 pointer-coarse:top-1/2 pointer-coarse:z-10 pointer-coarse:-translate-y-1/2 pointer-coarse:opacity-100",
				)}
			>
				{star && (
					// One name in both states, so the pressed state carries it ("Star", pressed); the tooltip says what a click does.
					<Tooltip label={star.starred ? t("Unstar") : t("Star")}>
						<Button
							type="button"
							variant="ghost"
							size="sm"
							className={buttonClassName}
							onClick={star.onToggle}
							aria-label={t("Star")}
							aria-pressed={star.starred}
						>
							<star.icon className={cn("h-4 w-4", star.starred && "fill-amber-400 text-amber-400")} />
						</Button>
					</Tooltip>
				)}
				<Tooltip label={t("Archive")}>
					<Button
						type="button"
						variant="ghost"
						size="sm"
						className={buttonClassName}
						onClick={() => void onAction("archive")}
						aria-label={t("Archive")}
					>
						<Archive className="h-4 w-4" />
					</Button>
				</Tooltip>
				<Tooltip label={t("Trash")}>
					<Button
						type="button"
						variant="ghost"
						size="sm"
						className={buttonClassName}
						onClick={() => void onAction("trash")}
						aria-label={t("Trash")}
					>
						<Trash2 className="h-4 w-4" />
					</Button>
				</Tooltip>
				<Tooltip label={readAction === "read" ? t("Mark as read") : t("Mark as unread")}>
					<Button
						type="button"
						variant="ghost"
						size="sm"
						className={buttonClassName}
						onClick={() => void onAction(readAction)}
						aria-label={readAction === "read" ? t("Mark as read") : t("Mark as unread")}
					>
						{readAction === "read" ? <MailOpen className="h-4 w-4" /> : <Mail className="h-4 w-4" />}
					</Button>
				</Tooltip>
				{snoozed ? (
					<Tooltip label={t("Unsnooze")}>
						<Button
							type="button"
							variant="ghost"
							size="sm"
							className={buttonClassName}
							onClick={() => void unsnoozeMessage(message.id).catch(reportListActionError)}
							aria-label={t("Unsnooze")}
						>
							<Clock className="h-4 w-4" />
						</Button>
					</Tooltip>
				) : (
					<Popover.Root open={snoozeOpen} onOpenChange={setSnoozeOpen}>
						<Tooltip label={snoozeOpen ? null : t("Snooze")}>
							<Popover.Trigger asChild>
								<Button type="button" variant="ghost" size="sm" className={buttonClassName} aria-label={t("Snooze")}>
									<Clock className="h-4 w-4" />
								</Button>
							</Popover.Trigger>
						</Tooltip>
						<Popover.Portal>
							<Popover.Content
								align="end"
								sideOffset={6}
								collisionPadding={8}
								aria-label={t("Snooze")}
								className="z-50 max-h-[min(70vh,24rem)] w-72 overflow-y-auto rounded-xl border border-neutral-200 bg-white p-2 shadow-lg"
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
