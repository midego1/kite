"use client";

import type { MailboxOption } from "@/components/mailbox-provider";
import { Input } from "@/components/ui/input";
import { Notice } from "@/components/ui/notice";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import type { AccountFormState } from "./connected-accounts-types";
import { NEW_MAILBOX_VALUE } from "./new-mailbox-utils";
import type { useNewMailbox } from "./use-new-mailbox";

const mailboxAddress = (mailbox: MailboxOption) => `${mailbox.localPart}@${mailbox.hostname}`;

/** "Mail goes to": the mailboxes the user manages, and "New mailbox for this account…" when they may create one. */
export function MailboxField({
	form,
	setForm,
	mailboxes,
	fresh,
}: {
	form: AccountFormState;
	setForm: (form: AccountFormState) => void;
	mailboxes: MailboxOption[];
	fresh: ReturnType<typeof useNewMailbox>;
}) {
	const {
		created,
		offered: offerNew,
		creating,
		domains,
		domainId: newDomainId,
		localPart: newLocalPart,
		problem: newProblem,
	} = fresh;
	const onNewMailbox = fresh.change;
	// The list may not know a mailbox that was just created yet.
	const unlisted = created && !mailboxes.some((mailbox) => mailbox.id === created.id) ? created : null;
	return (
		<div className="space-y-2">
			<Label htmlFor="external-mailbox">Mail goes to</Label>
			<Select
				id="external-mailbox"
				containerClassName="w-full"
				className="h-10 text-sm"
				value={form.mailboxId}
				onChange={(event) => setForm({ ...form, mailboxId: event.target.value })}
			>
				{mailboxes.map((mailbox) => (
					<option key={mailbox.id} value={mailbox.id}>
						{mailbox.displayName ? `${mailbox.displayName} (${mailboxAddress(mailbox)})` : mailboxAddress(mailbox)}
					</option>
				))}
				{unlisted && <option value={unlisted.id}>{unlisted.address}</option>}
				{offerNew && <option value={NEW_MAILBOX_VALUE}>New mailbox for this account…</option>}
			</Select>
			{creating && (
				<div className="space-y-2 rounded-lg bg-neutral-50 p-3">
					<div className="grid gap-3 md:grid-cols-[1fr_auto_1fr] md:items-end">
						<div className="space-y-2">
							<Label htmlFor="external-new-mailbox">Mailbox name</Label>
							<Input
								id="external-new-mailbox"
								value={newLocalPart}
								onChange={(event) => onNewMailbox({ localPart: event.target.value, edited: true })}
								autoComplete="off"
								spellCheck={false}
								aria-invalid={!!newProblem}
							/>
						</div>
						<span className="hidden pb-2 text-sm text-neutral-500 md:block">@</span>
						{domains.length > 1 ? (
							<div className="space-y-2">
								<Label htmlFor="external-new-mailbox-domain">Domain</Label>
								<Select
									id="external-new-mailbox-domain"
									containerClassName="w-full"
									className="h-10 text-sm"
									value={newDomainId}
									onChange={(event) => onNewMailbox({ domainId: event.target.value })}
								>
									{domains.map((domain) => (
										<option key={domain.id} value={domain.id}>
											{domain.hostname}
										</option>
									))}
								</Select>
							</div>
						) : (
							<p className="pb-2 text-sm text-neutral-700">{domains[0]?.hostname}</p>
						)}
					</div>
					{newProblem && newLocalPart ? (
						<p role="alert" className="text-xs text-red-600">
							{newProblem}
						</p>
					) : (
						<p className="text-xs text-neutral-500">
							Kite creates this mailbox first, then connects the account to it. Mail from the account, and what you
							import, arrives there instead of in your other mailboxes.
						</p>
					)}
				</div>
			)}
		</div>
	);
}

/** Connecting failed after the dialog created a mailbox: say so, and offer to reuse it (connect again) or delete it. */
export function MailboxLeftBehind({
	address,
	busy,
	onDelete,
}: {
	address: string;
	busy: boolean;
	onDelete: () => void;
}) {
	return (
		<Notice tone="warning" compact icon={false} role="none" data-testid="mailbox-left-behind">
			Kite created the mailbox {address}, but the account is not connected yet. Connect again to use that mailbox, or
			delete it.{" "}
			<button type="button" className="font-medium underline underline-offset-2" disabled={busy} onClick={onDelete}>
				Delete {address}
			</button>
		</Notice>
	);
}
