"use client";

import { useState } from "react";
import Link from "next/link";
import { Copy, KeyRound } from "lucide-react";
import { type MailboxOption, useSelectedMailbox } from "@/components/mailbox-provider";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { API_KEY_MAX_MAILBOXES } from "@/lib/api/scopes";
import { defaultAppPasswordMailboxIds, toggleMailboxId } from "./email-clients-settings-utils";
import { createJmapApiKey } from "./utils";

/**
 * Settings > App passwords card for connecting an external mail app over JMAP.
 * Mints an API key with the `jmap` scope and shows the details once. Mail scopes
 * need at least one mailbox, and a JMAP session lists only the mailboxes the key
 * was granted, so the form asks which ones the app may use.
 */
export function EmailClientsSettings() {
	const { mailboxes, selectedMailbox, isLoading } = useSelectedMailbox();
	const [name, setName] = useState("");
	// Null until the user changes the selection, so the default follows the mailbox list as it loads.
	const [chosenMailboxIds, setChosenMailboxIds] = useState<string[] | null>(null);
	const mailboxIds = chosenMailboxIds ?? defaultAppPasswordMailboxIds(mailboxes, selectedMailbox?.id);
	const [key, setKey] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [copied, setCopied] = useState<string | null>(null);
	const server = typeof window !== "undefined" ? window.location.origin : "";

	async function submit(event: React.FormEvent) {
		event.preventDefault();
		setBusy(true);
		setError(null);
		try {
			setKey(await createJmapApiKey(name.trim() || "Mail app", mailboxIds));
			setName("");
			setChosenMailboxIds(null);
		} catch (err) {
			setError(err instanceof Error ? err.message : "Could not create a key");
		} finally {
			setBusy(false);
		}
	}

	function copy(label: string, value: string) {
		void navigator.clipboard.writeText(value).then(() => setCopied(label));
	}

	return (
		<div className="space-y-4">
			<p className="text-sm text-neutral-500">
				App Password for email clients that support JMAP. Point the app at this server and sign in with your email
				address and an API key as the password.
			</p>
			{key ? (
				<div className="space-y-3 rounded-2xl bg-neutral-50 p-4">
					<Field label="Server" value={server} onCopy={copy} copied={copied} />
					<Field label="Username" value="any value" onCopy={copy} copied={copied} />
					<Field label="Password (API key)" value={key} onCopy={copy} copied={copied} mono />
					<p className="text-xs text-neutral-500">
						This key is shown once. You can revoke it in{" "}
						<Link href="/settings/api-keys" className="text-blue-700 underline">
							API keys
						</Link>
						. Session discovery is at <code>{server}/.well-known/jmap</code>.
					</p>
				</div>
			) : (
				<form onSubmit={submit} className="space-y-4">
					<div className="flex flex-wrap items-end gap-3">
						<div className="min-w-56 flex-1 space-y-2">
							<Label htmlFor="jmap-key-name">Device or app name</Label>
							<Input
								id="jmap-key-name"
								value={name}
								onChange={(event) => setName(event.target.value)}
								placeholder="Phone"
							/>
						</div>
						<Button type="submit" disabled={busy || isLoading || mailboxIds.length === 0}>
							<KeyRound className="h-4 w-4" />
							{busy ? "Creating..." : "Create app password"}
						</Button>
					</div>
					<AppPasswordMailboxes
						mailboxes={mailboxes}
						loading={isLoading}
						selectedIds={mailboxIds}
						onToggle={(id, checked) => setChosenMailboxIds(toggleMailboxId(mailboxIds, id, checked))}
					/>
					{error && (
						<p role="alert" className="text-sm text-red-600">
							{error}
						</p>
					)}
				</form>
			)}
		</div>
	);
}

function AppPasswordMailboxes({
	mailboxes,
	loading,
	selectedIds,
	onToggle,
}: {
	mailboxes: MailboxOption[];
	loading: boolean;
	selectedIds: string[];
	onToggle: (id: string, checked: boolean) => void;
}) {
	const atLimit = selectedIds.length >= API_KEY_MAX_MAILBOXES;
	return (
		<fieldset className="space-y-2">
			<legend className="text-sm font-medium text-neutral-900">Mailboxes this app can use</legend>
			{loading ? (
				<p className="text-sm text-neutral-500">Loading mailboxes...</p>
			) : mailboxes.length === 0 ? (
				<p className="text-sm text-neutral-500">You have no mailboxes to connect.</p>
			) : (
				<div className="grid gap-2 sm:grid-cols-2">
					{mailboxes.map((mailbox) => {
						const checked = selectedIds.includes(mailbox.id);
						return (
							<label key={mailbox.id} className="flex min-w-0 items-center gap-3 text-sm text-neutral-700">
								<Checkbox
									checked={checked}
									disabled={!checked && atLimit}
									onChange={(event) => onToggle(mailbox.id, event.target.checked)}
								/>
								<span className="truncate">
									{mailbox.localPart}@{mailbox.hostname}
								</span>
							</label>
						);
					})}
				</div>
			)}
			<p className="text-xs text-neutral-500">
				{!loading && mailboxes.length > 0 && selectedIds.length === 0
					? "Choose at least one mailbox."
					: `Aliases are included with their mailbox. Up to ${API_KEY_MAX_MAILBOXES} mailboxes per app password.`}
			</p>
		</fieldset>
	);
}

function Field({
	label,
	value,
	onCopy,
	copied,
	mono,
}: {
	label: string;
	value: string;
	onCopy: (label: string, value: string) => void;
	copied: string | null;
	mono?: boolean;
}) {
	return (
		<div className="flex items-center gap-3">
			<span className="w-36 shrink-0 text-xs font-medium uppercase tracking-wide text-neutral-500">{label}</span>
			<code
				className={`min-w-0 flex-1 truncate rounded-md bg-white px-2 py-1 text-sm ${mono ? "font-mono" : "font-sans"}`}
			>
				{value}
			</code>
			<Button type="button" variant="ghost" size="sm" onClick={() => onCopy(label, value)} aria-label={`Copy ${label}`}>
				<Copy className="h-4 w-4" />
				{copied === label ? "Copied" : "Copy"}
			</Button>
		</div>
	);
}
