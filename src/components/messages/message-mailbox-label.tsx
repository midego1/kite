"use client";

import type { MailboxOption } from "@/components/mailbox-provider";
import { getMailboxAddress, getMailboxName } from "@/components/mailbox-selector-utils";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { LabelDot } from "./label-dot";
import { useMailboxLabelColor } from "./use-label-colors";

/**
 * Which mailbox a row belongs to in the All mailboxes view. `full` is a neutral pill (the palette variables, so it
 * follows light, dark and both styles) with a dot in the mailbox's label colour (the one chosen in Settings → Inbox, else
 * an automatic one), placed at the row's right edge; on
 * a narrow list the pill shortens its own name before the subject loses its room. `compact` is that dot alone, with
 * the name in its accessible name and tooltip, so the subject keeps the room.
 */
export function MessageMailboxLabel({
	mailbox,
	variant = "full",
	className,
}: {
	mailbox: MailboxOption | undefined;
	variant?: "compact" | "full";
	className?: string;
}) {
	const colorOf = useMailboxLabelColor();
	if (!mailbox) return null;
	const address = getMailboxAddress(mailbox);
	const color = colorOf(mailbox.id).value;
	if (variant === "compact") {
		const name = getMailboxName(mailbox);
		return (
			<span
				role="img"
				data-testid="message-mailbox-label"
				data-label-variant="compact"
				aria-label={`Mailbox: ${name}`}
				title={`Mailbox: ${name === address ? address : `${name} (${address})`}`}
				className={cn("relative z-10 inline-flex h-4 w-3.5 shrink-0 items-center justify-center", className)}
			>
				<LabelDot color={color} />
			</span>
		);
	}
	return (
		<Badge
			variant="secondary"
			data-testid="message-mailbox-label"
			data-label-variant="full"
			title={address}
			className={cn(
				"inline-flex min-w-0 max-w-32 shrink items-center gap-1 rounded-full px-2 py-0 text-[11px] font-medium normal-case text-neutral-600",
				className,
			)}
		>
			<LabelDot color={color} className="h-2 w-2 rounded-[2px] ring-0" />
			<span className="truncate">
				<span className="sr-only">Mailbox: </span>
				{getMailboxName(mailbox)}
			</span>
		</Badge>
	);
}
