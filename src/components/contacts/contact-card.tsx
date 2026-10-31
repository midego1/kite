"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import * as Popover from "@radix-ui/react-popover";
import { useCompose } from "@/components/compose/compose-context";
import { useMailSearch } from "@/components/mail-search/mail-search-context";
import { blockMessageContact } from "@/components/message-actions/utils";
import { useMessageAccess } from "@/components/messages/use-message-access";
import { Tooltip } from "@/components/ui/tooltip";
import { getEmailAddress } from "@/lib/email/address";
import { cn } from "@/lib/utils";
import { ContactCardActions, ContactCardHeader } from "./contact-card-content";
import { createDraftTo } from "./contact-card-api";
import type { ContactCardProps } from "./contact-card-types";
import {
	contactCardAccess,
	fromSearchQuery,
	isOwnAddress,
	participantTooltip,
	savedContactName,
} from "./contact-card-utils";
import { ContactDetailsDialog } from "./contact-details";
import { fetchContactDetails } from "./contact-details-utils";
import type { ContactDetailsRecord } from "./contact-details-types";

/**
 * A person in the reader as a button: hover or focus shows the full address, click or Enter opens a small card
 * with the address (and Copy) and what you can do about them. It reuses the composer, the mail search, the
 * contact dialog and the block-contact request; the server decides who may change the contact.
 */
export function ContactCard({
	mailboxId,
	address,
	name,
	ownAddresses,
	ownAddress,
	otherAddresses,
	tooltip = true,
	triggerClassName,
	children,
}: ContactCardProps) {
	const email = getEmailAddress(address).trim();
	const own = isOwnAddress(email, ownAddresses);
	const router = useRouter();
	const { openDraftComposer } = useCompose();
	const { setQuery } = useMailSearch();
	const { mailboxOf } = useMessageAccess();
	const [open, setOpen] = useState(false);
	const [editing, setEditing] = useState(false);
	const [contact, setContact] = useState<ContactDetailsRecord | null>(null);
	const [copied, setCopied] = useState(false);
	const [confirmBlock, setConfirmBlock] = useState(false);
	const [blocked, setBlocked] = useState(false);
	const [pending, setPending] = useState<"draft" | "block" | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [shownName, setShownName] = useState(name);
	// Mailboxes listed without a permission are the user's own. A mailbox that is not listed grants nothing.
	const mailbox = mailboxOf(mailboxId);
	const access = contactCardAccess(mailbox ? (mailbox.permission ?? "full_access") : null);

	// Contact details (saved name, blocked) are read when the card opens, never for the hover.
	useEffect(() => {
		if (!open || !mailboxId || own || !email) return;
		let cancelled = false;
		fetchContactDetails(mailboxId, email)
			.then((next) => {
				if (cancelled) return;
				setContact(next);
				const saved = savedContactName(next);
				if (saved) setShownName(saved);
			})
			.catch(() => undefined);
		return () => {
			cancelled = true;
		};
	}, [open, mailboxId, email, own]);

	useEffect(() => {
		if (!copied) return;
		const timer = window.setTimeout(() => setCopied(false), 1800);
		return () => window.clearTimeout(timer);
	}, [copied]);

	function handleOpenChange(next: boolean) {
		setOpen(next);
		if (!next) {
			setConfirmBlock(false);
			setError(null);
		}
	}

	async function copyAddress() {
		try {
			await navigator.clipboard.writeText(email);
			setCopied(true);
		} catch {
			setError("Could not copy the address");
		}
	}

	async function newEmail() {
		setError(null);
		setPending("draft");
		try {
			const draftId = await createDraftTo({ mailboxId, from: ownAddress, address: email });
			setOpen(false);
			openDraftComposer(draftId);
		} catch (draftError) {
			setError(draftError instanceof Error ? draftError.message : "Unable to start a new email");
		} finally {
			setPending(null);
		}
	}

	function showMailFrom() {
		setOpen(false);
		setQuery(fromSearchQuery(email));
		router.push("/inbox");
	}

	async function block() {
		if (!mailboxId || pending) return;
		setError(null);
		setPending("block");
		try {
			await blockMessageContact({ mailboxId, senderAddress: email });
			setBlocked(true);
			setConfirmBlock(false);
		} catch (blockError) {
			setError(blockError instanceof Error ? blockError.message : "Could not block contact");
		} finally {
			setPending(null);
		}
	}

	const hoverLabel = tooltip && !open ? participantTooltip(email, otherAddresses) : null;
	const isContact = !!contact?.source;
	const isBlocked = blocked || !!contact?.blocked;
	const displayName = own ? name : shownName;

	return (
		<>
			<Popover.Root open={open} onOpenChange={handleOpenChange}>
				<Tooltip label={hoverLabel}>
					<Popover.Trigger asChild>
						<button
							type="button"
							aria-haspopup="dialog"
							className={cn(
								"cursor-pointer rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-300",
								triggerClassName,
							)}
						>
							{children}
						</button>
					</Popover.Trigger>
				</Tooltip>
				<Popover.Portal>
					<Popover.Content
						align="start"
						sideOffset={6}
						collisionPadding={8}
						aria-label={`Contact card for ${displayName}`}
						data-contact-card
						className="z-[130] w-[min(20rem,calc(100vw-1rem))] rounded-xl border border-neutral-200 bg-white p-2 text-neutral-900 shadow-lg"
					>
						<ContactCardHeader
							mailboxId={mailboxId}
							email={email}
							displayName={displayName}
							own={own}
							contact={contact}
							blocked={isBlocked}
							otherAddresses={otherAddresses}
							copied={copied}
							onCopy={() => void copyAddress()}
						/>
						{!own && (
							<ContactCardActions
								email={email}
								displayName={displayName}
								canEdit={!!mailboxId && access.canEdit}
								canSend={access.canSend}
								isContact={isContact}
								blocked={isBlocked}
								confirmBlock={confirmBlock}
								busy={pending !== null}
								onNewEmail={() => void newEmail()}
								onShowMail={showMailFrom}
								onEdit={() => {
									setOpen(false);
									setEditing(true);
								}}
								onBlock={() => (confirmBlock ? void block() : setConfirmBlock(true))}
							/>
						)}
						{error && (
							<p role="alert" className="px-3 pb-1 pt-2 text-xs text-red-600">
								{error}
							</p>
						)}
						<span aria-live="polite" className="sr-only">
							{copied ? "Address copied" : ""}
						</span>
					</Popover.Content>
				</Popover.Portal>
			</Popover.Root>
			{mailboxId && !own && (
				<ContactDetailsDialog
					mailboxId={mailboxId}
					address={email}
					name={displayName}
					open={editing}
					onOpenChange={setEditing}
					onSaved={(saved) => {
						setShownName(saved);
						setContact((current) => (current ? { ...current, source: current.source ?? "manual" } : current));
					}}
				/>
			)}
		</>
	);
}
