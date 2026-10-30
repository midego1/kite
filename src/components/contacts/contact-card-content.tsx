"use client";

import { Ban, Check, Copy, Pencil, PenSquare, Search, UserPlus } from "lucide-react";
import { ContactAvatar } from "./contact-avatar";
import { showMailFromLabel } from "./contact-card-utils";
import type { ContactCardActionsProps, ContactCardHeaderProps } from "./contact-card-types";

const itemClass =
	"flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-neutral-700 hover:bg-neutral-100 focus-visible:bg-neutral-100 focus-visible:outline-none disabled:cursor-not-allowed disabled:text-neutral-400";

/** The top of the card: avatar, name with its You and Blocked badges, the address and Copy. */
export function ContactCardHeader({
	mailboxId,
	email,
	displayName,
	own,
	contact,
	copied,
	onCopy,
}: ContactCardHeaderProps) {
	return (
		<div className="flex items-center gap-3 px-3 pb-2 pt-2">
			<ContactAvatar
				mailboxId={mailboxId}
				address={email}
				name={displayName}
				hasManagedAvatar={contact?.hasAvatar ?? false}
				className="h-10 w-10"
			/>
			<div className="min-w-0 flex-1">
				<p dir="auto" className="flex items-center gap-2 text-sm font-medium">
					<span className="truncate">{displayName}</span>
					{own && (
						<span className="shrink-0 rounded-full bg-neutral-100 px-2 py-0.5 text-xs font-medium text-neutral-600">
							You
						</span>
					)}
					{contact?.blocked && (
						<span className="shrink-0 rounded-full bg-red-50 px-2 py-0.5 text-xs font-medium text-red-600">
							Blocked
						</span>
					)}
				</p>
				<p data-contact-card-address className="break-all text-xs text-neutral-500">
					{email}
				</p>
			</div>
			<button
				type="button"
				onClick={onCopy}
				aria-label={copied ? "Address copied" : "Copy address"}
				className="flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-neutral-200 px-2 text-xs font-medium text-neutral-700 hover:bg-neutral-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-300"
			>
				{copied ? <Check className="h-3.5 w-3.5" aria-hidden /> : <Copy className="h-3.5 w-3.5" aria-hidden />}
				{copied ? "Copied" : "Copy"}
			</button>
		</div>
	);
}

/** What you can do about someone else: write to them, find their mail, edit or block the contact. */
export function ContactCardActions({
	email,
	displayName,
	canEdit,
	isContact,
	blocked,
	confirmBlock,
	busy,
	onNewEmail,
	onShowMail,
	onEdit,
	onBlock,
}: ContactCardActionsProps) {
	return (
		<>
			<hr className="my-1 border-neutral-100" />
			<button type="button" className={itemClass} disabled={busy} onClick={onNewEmail}>
				<PenSquare className="h-4 w-4 shrink-0" aria-hidden />
				New email
			</button>
			<button type="button" className={itemClass} onClick={onShowMail}>
				<Search className="h-4 w-4 shrink-0" aria-hidden />
				<span className="min-w-0 truncate">{showMailFromLabel(displayName, email)}</span>
			</button>
			{canEdit && (
				<button type="button" className={itemClass} onClick={onEdit}>
					{isContact ? (
						<Pencil className="h-4 w-4 shrink-0" aria-hidden />
					) : (
						<UserPlus className="h-4 w-4 shrink-0" aria-hidden />
					)}
					{isContact ? "Edit contact" : "Add to contacts"}
				</button>
			)}
			{canEdit && !blocked && (
				<button
					type="button"
					className={`${itemClass} ${confirmBlock ? "text-red-600" : ""}`}
					disabled={busy}
					onClick={onBlock}
				>
					<Ban className="h-4 w-4 shrink-0" aria-hidden />
					{confirmBlock ? "Confirm: block this contact" : "Block contact"}
				</button>
			)}
		</>
	);
}
