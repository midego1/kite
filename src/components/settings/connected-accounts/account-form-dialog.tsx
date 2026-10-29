"use client";

import type { FormEvent } from "react";
import { useState } from "react";
import { useSelectedMailbox, type MailboxOption } from "@/components/mailbox-provider";
import { WARNING_NOTICE_CLASS } from "@/components/notice-styles";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import type { ExternalAccountView } from "@/lib/external-accounts/types";
import type { AccountFormState, PresetOption } from "./connected-accounts-types";
import {
	accountForm,
	canSubmitAccountForm,
	connectAccount,
	detectProvider,
	emptyAccountForm,
	updateAccount,
} from "./connected-accounts-utils";

type FieldsProps = { form: AccountFormState; setForm: (form: AccountFormState) => void };

const mailboxAddress = (mailbox: MailboxOption) => `${mailbox.localPart}@${mailbox.hostname}`;

/**
 * Connect an account, or edit one (`account` set). A known provider brings its own servers; "Other" asks for them.
 * The Kite password is asked again because the account's password is saved (spec §11.5).
 */
export function AccountFormDialog({
	open,
	onOpenChange,
	account,
	presets,
	onSaved,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	account: ExternalAccountView | null;
	presets: PresetOption[];
	onSaved: (account: ExternalAccountView, connected: boolean) => void;
}) {
	const { mailboxes, selectedMailbox } = useSelectedMailbox();
	const managed = mailboxes.filter((mailbox) => (mailbox.permission ?? "full_access") === "full_access");
	const [draft, setForm] = useState<AccountFormState>(() =>
		account ? accountForm(account) : emptyAccountForm(selectedMailbox?.id ?? managed[0]?.id ?? ""),
	);
	// The mailboxes may arrive after the dialog opened; until one is chosen, the first one the user manages is used.
	const form = draft.mailboxId ? draft : { ...draft, mailboxId: managed[0]?.id ?? "" };
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const preset = presets.find((entry) => entry.id === form.preset);
	const editing = !!account;
	const mailbox = managed.find((entry) => entry.id === form.mailboxId);

	async function detect() {
		if (editing || !form.address.includes("@")) return;
		const detected = await detectProvider(form.address.trim());
		setForm((current) =>
			current.preset === "other" && !current.imapHost ? { ...current, preset: detected } : current,
		);
	}

	async function submit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		setSaving(true);
		setError(null);
		try {
			const saved = account ? await updateAccount(account.id, form) : await connectAccount(form);
			onSaved(saved, !account);
		} catch (submitError) {
			setError(submitError instanceof Error ? submitError.message : "Could not save the account");
		} finally {
			setSaving(false);
		}
	}

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="max-h-[calc(100vh-4rem)] w-[min(560px,calc(100vw-32px))] overflow-y-auto">
				<DialogHeader>
					<DialogTitle>{editing ? `Edit ${account.address}` : "Connect an account"}</DialogTitle>
					<DialogDescription>
						Kite signs in to the account over an encrypted connection and saves the password encrypted. Nothing at the
						provider is changed.
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
					{form.preset === "other" && <ServerFields form={form} setForm={setForm} />}
					{preset?.passwordSignIn !== false && (
						<CredentialFields form={form} setForm={setForm} preset={preset} editing={editing} />
					)}
					<MailboxField form={form} setForm={setForm} mailboxes={managed} />
					{mailbox?.type === "shared" && (
						<p className={WARNING_NOTICE_CLASS}>
							Everyone with access to {mailbox.displayName || mailboxAddress(mailbox)} will see mail from this account.
						</p>
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
						<Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
							Cancel
						</Button>
						<Button type="submit" disabled={saving || !canSubmitAccountForm(form, editing, preset)}>
							{saving ? "Testing the connection…" : editing ? "Save" : "Connect"}
						</Button>
					</div>
				</form>
			</DialogContent>
		</Dialog>
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

function MailboxField({ form, setForm, mailboxes }: FieldsProps & { mailboxes: MailboxOption[] }) {
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
			</Select>
		</div>
	);
}
