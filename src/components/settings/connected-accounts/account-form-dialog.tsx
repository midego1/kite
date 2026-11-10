"use client";

import type { FormEvent } from "react";
import { useState } from "react";
import { useSelectedMailbox, type MailboxOption } from "@/components/mailbox-provider";
import { Button } from "@/components/ui/button";
import { Notice } from "@/components/ui/notice";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import type { ExternalAccountView } from "@/lib/external-accounts/types";
import type { AccountFormState, PresetOption } from "./connected-accounts-types";
import { forwardingProviderFor, type ForwardingProviderId } from "./forwarding-guide-utils";
import { MailboxField, MailboxLeftBehind } from "./account-mailbox-field";
import { chosenMailboxId, errorText, firstId, NEW_MAILBOX_VALUE, unusedMailboxAddress } from "./new-mailbox-utils";
import { useNewMailbox } from "./use-new-mailbox";
import {
	accountForm,
	canSubmitAccountForm,
	submitLabel,
	detectProvider,
	emptyAccountForm,
	SYNC_INTERVAL_OPTIONS,
	saveAccount,
	startMicrosoftSignIn,
	usesMicrosoftSignIn,
} from "./connected-accounts-utils";
import { MicrosoftLogo, MicrosoftSignInFields } from "./microsoft-sign-in";

type FieldsProps = { form: AccountFormState; setForm: (form: AccountFormState) => void };

const mailboxAddress = (mailbox: MailboxOption) => `${mailbox.localPart}@${mailbox.hostname}`;

/**
 * Connect an account, or edit one (`account` set). A known provider brings its own servers; "Other" asks for them.
 * The Kite password is asked again because the account's password is saved (spec §11.5). Microsoft accounts sign in
 * with Microsoft instead (`microsoftSignIn`, spec §15): the dialog sends the browser to Microsoft's sign-in page.
 */
export function AccountFormDialog({
	open,
	onOpenChange,
	account,
	presets,
	microsoftSignIn = false,
	onSaved,
	onForwardInstead,
	onMailboxLeftBehind,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	account: ExternalAccountView | null;
	presets: PresetOption[];
	/** The owner set up Sign in with Microsoft, so Microsoft accounts can be connected. */
	microsoftSignIn?: boolean;
	/** Closes the dialog and opens the forwarding guide at this provider (where connecting is not possible). */
	onForwardInstead?: (provider: ForwardingProviderId) => void;
	/** `unusedMailbox`: the address of a mailbox Kite created for this try that the account was not connected to. */
	onSaved: (account: ExternalAccountView, connected: boolean, unusedMailbox?: string) => void;
	/** The dialog closed with a mailbox it created but no account connected to it (the address of that mailbox). */
	onMailboxLeftBehind?: (address: string) => void;
}) {
	const { mailboxes, selectedMailbox, isLoading } = useSelectedMailbox();
	const managed = mailboxes.filter((mailbox) => (mailbox.permission ?? "full_access") === "full_access");
	const [draft, setForm] = useState<AccountFormState>(() =>
		account ? accountForm(account) : emptyAccountForm(firstId(selectedMailbox?.id, managed[0]?.id)),
	);
	// The mailboxes may arrive after the dialog opened; until one is chosen, the first one the user manages is used.
	const chosenId = firstId(draft.mailboxId, managed[0]?.id);
	const [saving, setSaving] = useState<"mailbox" | "account" | "delete" | "microsoft" | null>(null);
	const [error, setError] = useState<string | null>(null);
	// With no mailbox to choose from (a new account of someone who may create mailboxes) the new mailbox is the choice.
	const fresh = useNewMailbox({
		editing: !!account,
		address: draft.address,
		mailboxId: chosenId || (isLoading ? "" : NEW_MAILBOX_VALUE),
		mailboxes,
	});
	const form = {
		...draft,
		mailboxId: chosenMailboxId({
			chosen: draft.mailboxId,
			firstManaged: managed[0]?.id,
			offered: fresh.offered,
			loading: isLoading,
		}),
	};
	const preset = presets.find((entry) => entry.id === form.preset);
	const editing = !!account;
	const microsoft = usesMicrosoftSignIn(form.preset, account, microsoftSignIn);
	const { created } = fresh;
	const mailbox = managed.find((entry) => entry.id === form.mailboxId);

	function close(open: boolean) {
		// Escape and the close button must not end a request that is creating a mailbox or connecting to it.
		if (!open && saving !== null) return;
		if (!open && created) onMailboxLeftBehind?.(created.address);
		onOpenChange(open);
	}

	async function detect() {
		if (editing || !form.address.includes("@")) return;
		const detected = await detectProvider(form.address.trim());
		setForm((current) =>
			current.preset === "other" && !current.imapHost ? { ...current, preset: detected } : current,
		);
	}

	async function submit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		setError(null);
		let target: { id: string } | null = null;
		try {
			if (fresh.creating) setSaving("mailbox");
			target = await fresh.ensure();
		} catch (createError) {
			// Nothing was created, so nothing is left to explain: the person fixes the name and tries again.
			setError(errorText(createError, "Could not create the mailbox"));
			setSaving(null);
			return;
		}
		// From here on the dialog stands on the new mailbox, so a second try reuses it instead of making another.
		const connecting = target ? { ...form, mailboxId: target.id } : form;
		if (target) setForm(connecting);
		if (microsoft && !editing) {
			await signInWithMicrosoft(connecting);
			return;
		}
		setSaving("account");
		try {
			const saved = await saveAccount(account, connecting);
			// A mailbox made earlier by this dialog that the person then left for another one stays; say so.
			const unused = unusedMailboxAddress(created, connecting.mailboxId);
			fresh.clear();
			onSaved(saved, !account, unused);
		} catch (submitError) {
			setError(errorText(submitError, "Could not save the account"));
		} finally {
			setSaving(null);
		}
	}

	/** Opens Microsoft's sign-in page; the callback brings the browser back to Connected accounts. */
	async function signInWithMicrosoft(source: AccountFormState, accountId?: string) {
		setSaving("microsoft");
		setError(null);
		try {
			window.location.assign(await startMicrosoftSignIn(source, accountId));
		} catch (startError) {
			setError(errorText(startError, "Could not start the Microsoft sign-in"));
			setSaving(null);
		}
	}

	async function deleteCreated() {
		setSaving("delete");
		setError(null);
		try {
			await fresh.deleteCreated();
			setForm({ ...form, mailboxId: firstId(selectedMailbox?.id, managed[0]?.id) });
		} catch (deleteError) {
			setError(errorText(deleteError, "Could not delete the mailbox"));
		} finally {
			setSaving(null);
		}
	}

	return (
		<Dialog open={open} onOpenChange={close}>
			<DialogContent className="max-h-[calc(100vh-4rem)] w-[min(560px,calc(100vw-32px))] overflow-y-auto">
				<DialogHeader>
					<DialogTitle>{editing ? `Edit ${account.address}` : "Connect an account"}</DialogTitle>
					<DialogDescription>
						Kite signs in to the account over an encrypted connection and saves{" "}
						{microsoft ? "its Microsoft sign-in" : "the password"} encrypted. Nothing at the provider is changed.
					</DialogDescription>
				</DialogHeader>
				<form onSubmit={(event) => void submit(event)} className="space-y-4" aria-label="Account settings">
					<div className="space-y-2">
						<Label htmlFor="external-address">Email address</Label>
						<Input
							id="external-address"
							type="email"
							value={form.address}
							disabled={editing}
							onChange={(event) => setForm({ ...form, address: event.target.value })}
							onBlur={() => void detect()}
							placeholder="you@gmail.com"
							required
						/>
					</div>
					<ProviderFields form={form} setForm={setForm} presets={presets} preset={preset} />
					<SignInFields
						form={form}
						setForm={setForm}
						preset={preset}
						editing={editing}
						microsoft={microsoft}
						onForwardInstead={onForwardInstead}
						reconnect={
							account?.authKind === "oauth_microsoft"
								? { busy: saving !== null, onClick: () => void signInWithMicrosoft(form, account.id) }
								: null
						}
					/>
					<MailboxField form={form} setForm={setForm} mailboxes={managed} fresh={fresh} />
					<IntervalField form={form} setForm={setForm} />
					{mailbox?.type === "shared" && (
						<Notice tone="warning" compact icon={false} role="none">
							Everyone with access to {mailbox.displayName || mailboxAddress(mailbox)} will see mail from this account.
						</Notice>
					)}
					{created && (
						<MailboxLeftBehind address={created.address} busy={saving !== null} onDelete={() => void deleteCreated()} />
					)}
					{error && (
						<p
							role="alert"
							className="rounded-lg border border-[#ef4444]/25 bg-[#ef4444]/10 px-4 py-3 text-sm text-[#b91c1c] dark:text-[#f19999]"
						>
							{error}
						</p>
					)}
					<div className="flex justify-end gap-2">
						<Button type="button" variant="outline" onClick={() => close(false)} disabled={saving !== null}>
							Cancel
						</Button>
						<Button
							type="submit"
							disabled={saving !== null || !!fresh.problem || !canSubmitAccountForm(form, editing, preset, microsoft)}
						>
							<SubmitLabel saving={saving} editing={editing} microsoft={microsoft} />
						</Button>
					</div>
				</form>
			</DialogContent>
		</Dialog>
	);
}

/** The submit button's text, with Microsoft's logo while it reads Sign in with Microsoft. */
function SubmitLabel({
	saving,
	editing,
	microsoft,
}: {
	saving: Parameters<typeof submitLabel>[0];
	editing: boolean;
	microsoft: boolean;
}) {
	return (
		<>
			{microsoft && !editing && saving === null && <MicrosoftLogo />}
			{submitLabel(saving, editing, microsoft)}
		</>
	);
}

/**
 * How the account signs in: the servers ("Other"), the password fields, Sign in with Microsoft, or, for a Microsoft
 * account on a Kite without Microsoft sign-in, the offer to forward its mail instead.
 */
function SignInFields({
	form,
	setForm,
	preset,
	editing,
	microsoft,
	onForwardInstead,
	reconnect,
}: FieldsProps & {
	preset: PresetOption | undefined;
	editing: boolean;
	microsoft: boolean;
	onForwardInstead?: (provider: ForwardingProviderId) => void;
	reconnect: { busy: boolean; onClick: () => void } | null;
}) {
	return (
		<>
			{preset?.passwordSignIn === false && !microsoft && onForwardInstead && (
				<Notice tone="warning" compact icon={false} role="none">
					{form.preset === "microsoft" && "Microsoft sign-in is not set up on this Kite yet; ask your admin. "}
					Forward this account&apos;s mail to Kite instead: it needs no password.{" "}
					<button
						type="button"
						className="font-medium underline underline-offset-2"
						onClick={() => onForwardInstead(forwardingProviderFor(preset.id))}
					>
						Set up forwarding
					</button>
				</Notice>
			)}
			{form.preset === "other" && <ServerFields form={form} setForm={setForm} />}
			{preset?.passwordSignIn !== false && (
				<CredentialFields form={form} setForm={setForm} preset={preset} editing={editing} />
			)}
			{microsoft && <MicrosoftSignInFields form={form} setForm={setForm} reconnect={reconnect} />}
		</>
	);
}

function ProviderFields({
	form,
	setForm,
	presets,
	preset,
}: FieldsProps & { presets: PresetOption[]; preset: PresetOption | undefined }) {
	return (
		<div className="space-y-2">
			<Label htmlFor="external-provider">Provider</Label>
			<Select
				id="external-provider"
				containerClassName="w-full"
				className="h-10 text-sm"
				value={form.preset}
				onChange={(event) => setForm({ ...form, preset: event.target.value as AccountFormState["preset"] })}
			>
				{presets.map((option) => (
					<option key={option.id} value={option.id}>
						{option.label}
					</option>
				))}
			</Select>
			{preset && preset.id !== "other" && (
				<p className="text-xs text-neutral-500">
					{preset.passwordSignIn ? `Kite signs in at ${preset.imap.host}.` : preset.passwordHelp}
				</p>
			)}
		</div>
	);
}

function SecuritySelect({
	id,
	label,
	value,
	onChange,
}: {
	id: string;
	label: string;
	value: "tls" | "starttls";
	onChange: (value: "tls" | "starttls") => void;
}) {
	return (
		<div className="space-y-2">
			<Label htmlFor={id}>{label}</Label>
			<Select
				id={id}
				containerClassName="w-full"
				className="h-10 text-sm"
				value={value}
				onChange={(event) => onChange(event.target.value as "tls" | "starttls")}
			>
				<option value="tls">TLS</option>
				<option value="starttls">STARTTLS</option>
			</Select>
		</div>
	);
}

function ServerFields({ form, setForm }: FieldsProps) {
	return (
		<div className="space-y-3 rounded-lg bg-neutral-50 p-3">
			<div className="grid gap-3 md:grid-cols-[1fr_90px_130px]">
				<div className="space-y-2">
					<Label htmlFor="external-imap-host">IMAP server</Label>
					<Input
						id="external-imap-host"
						value={form.imapHost}
						onChange={(event) => setForm({ ...form, imapHost: event.target.value })}
						placeholder="imap.example.com"
					/>
				</div>
				<div className="space-y-2">
					<Label htmlFor="external-imap-port">Port</Label>
					<Input
						id="external-imap-port"
						type="number"
						value={form.imapPort}
						onChange={(event) => setForm({ ...form, imapPort: event.target.value })}
					/>
				</div>
				<SecuritySelect
					id="external-imap-security"
					label="Encryption"
					value={form.imapSecurity}
					onChange={(imapSecurity) => setForm({ ...form, imapSecurity })}
				/>
			</div>
			<div className="grid gap-3 md:grid-cols-[1fr_90px_130px]">
				<div className="space-y-2">
					<Label htmlFor="external-smtp-host">SMTP server (optional)</Label>
					<Input
						id="external-smtp-host"
						value={form.smtpHost}
						onChange={(event) => setForm({ ...form, smtpHost: event.target.value })}
						placeholder="smtp.example.com"
					/>
				</div>
				<div className="space-y-2">
					<Label htmlFor="external-smtp-port">Port</Label>
					<Input
						id="external-smtp-port"
						type="number"
						value={form.smtpPort}
						onChange={(event) => setForm({ ...form, smtpPort: event.target.value })}
					/>
				</div>
				<SecuritySelect
					id="external-smtp-security"
					label="Encryption"
					value={form.smtpSecurity}
					onChange={(smtpSecurity) => setForm({ ...form, smtpSecurity })}
				/>
			</div>
		</div>
	);
}

function CredentialFields({
	form,
	setForm,
	preset,
	editing,
}: FieldsProps & { preset: PresetOption | undefined; editing: boolean }) {
	return (
		<>
			<div className={form.preset === "other" ? "grid gap-3 md:grid-cols-2" : "space-y-2"}>
				{/* A known provider signs in with the address itself; only "Other" may use another user name. */}
				{form.preset === "other" && (
					<div className="space-y-2">
						<Label htmlFor="external-username">User name</Label>
						<Input
							id="external-username"
							value={form.username}
							onChange={(event) => setForm({ ...form, username: event.target.value })}
							placeholder={form.address || "Same as the address"}
							autoComplete="off"
						/>
					</div>
				)}
				<div className="space-y-2">
					<Label htmlFor="external-password">Password or app password</Label>
					<Input
						id="external-password"
						type="password"
						value={form.password}
						onChange={(event) => setForm({ ...form, password: event.target.value })}
						placeholder={editing ? "Leave empty to keep it (unless a server changes)" : undefined}
						autoComplete="new-password"
					/>
				</div>
			</div>
			{preset && <p className="text-xs text-neutral-500">{preset.passwordHelp}</p>}
			<div className="space-y-2">
				<Label htmlFor="external-kite-password">Your Kite password</Label>
				<Input
					id="external-kite-password"
					type="password"
					value={form.kitePassword}
					onChange={(event) => setForm({ ...form, kitePassword: event.target.value })}
					autoComplete="current-password"
				/>
				<p className="text-xs text-neutral-500">
					{editing
						? "Needed, with the account's password, when you change the password, the user name or a server."
						: "Asked again because Kite saves the account's password."}
				</p>
			</div>
		</>
	);
}

function IntervalField({ form, setForm }: FieldsProps) {
	return (
		<div className="space-y-2">
			<Label htmlFor="external-sync-interval">Check for new mail</Label>
			<Select
				id="external-sync-interval"
				containerClassName="w-full"
				className="h-10 text-sm"
				value={form.syncIntervalMinutes}
				onChange={(event) => setForm({ ...form, syncIntervalMinutes: event.target.value })}
			>
				{SYNC_INTERVAL_OPTIONS.map((option) => (
					<option key={option.value} value={option.value}>
						{option.label}
					</option>
				))}
			</Select>
			<p className="text-xs text-neutral-500">
				Kite checks the Inbox for mail that arrives after you connect. For mail the moment it arrives, also set up
				forwarding at the provider.
			</p>
		</div>
	);
}
