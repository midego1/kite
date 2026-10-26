"use client";

import type { MailboxOption } from "@/components/mailbox-provider";
import { getMailboxAddress, getMailboxName } from "@/components/mailbox-selector-utils";
import { Badge } from "@/components/ui/badge";
import { getAvatarColorStyle } from "@/lib/avatar-colors";
import { cn } from "@/lib/utils";

/** Which mailbox a row belongs to in the All mailboxes view, in the mailbox's avatar colour. */
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
			aria-label={`Mailbox: ${address}`}
			style={getAvatarColorStyle(address)}
			className={cn("mr-1.5 max-w-32 shrink-0 truncate px-1.5 py-0 align-middle normal-case", className)}
		>
			{getMailboxName(mailbox)}
		</Badge>
	);
}
