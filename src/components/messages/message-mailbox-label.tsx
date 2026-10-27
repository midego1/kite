"use client";

import type { MailboxOption } from "@/components/mailbox-provider";
import { getMailboxAddress, getMailboxName } from "@/components/mailbox-selector-utils";
import { Badge } from "@/components/ui/badge";
import { getAvatarColorStyle } from "@/lib/avatar-colors";
import { cn } from "@/lib/utils";

/**
 * Which mailbox a row belongs to in the All mailboxes view: a neutral pill (the palette variables, so it
 * follows light, dark and both styles) with a dot in the mailbox's avatar colour.
 */
export function MessageMailboxLabel({
	mailbox,
	className,
}: {
	mailbox: MailboxOption | undefined;
	className?: string;
}) {
	if (!mailbox) return null;
	const address = getMailboxAddress(mailbox);
	return (
		<Badge
			variant="secondary"
			data-testid="message-mailbox-label"
			title={address}
			className={cn(
				"mr-1.5 inline-flex max-w-32 shrink-0 items-center gap-1 rounded-full px-2 py-0 align-middle text-[11px] font-medium normal-case text-neutral-600",
				className,
			)}
		>
			<span
				aria-hidden
				className="h-1.5 w-1.5 shrink-0 rounded-full"
				style={{ backgroundColor: getAvatarColorStyle(address).backgroundColor }}
			/>
			<span className="truncate">
				<span className="sr-only">Mailbox: </span>
				{getMailboxName(mailbox)}
			</span>
		</Badge>
	);
}
