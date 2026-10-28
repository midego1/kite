"use client";

import type { FormEvent } from "react";
import { useState } from "react";
import { Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { ImportSizeNotice } from "@/components/settings/import-size-notice";
import { AccountMappingTable } from "./account-mapping-table";
import type { AccountPlan, ImapFormState, ImapImportMode, ImportFolderSummary } from "./types";
import {
	adoptExistingFolders,
	canSubmitImap,
	createAccountImportJob,
	createImapImportJob,
	estimatedImapMessages,
	fetchAccountPlan,
	fetchMailboxFolders,
	imapSecurityValue,
	plannedMessageCount,
	systemDestinations,
	withImapSecurity,
} from "./utils";

const initialImapForm: ImapFormState = {
	mode: "account",
	destination: "system:inbox",
	host: "",
	port: "993",
	secure: true,
	username: "",
	password: "",
	folder: "INBOX",
	limit: "100",
	importAll: true,
};

type FormProps = { form: ImapFormState; setForm: (form: ImapFormState) => void };

/**
 * The IMAP import: a whole account through the mapping table (spec §4.1), or one folder into one place. Either way
 * the server copies the mail in the background, so the page can be closed.
 */
export function ImapImportForm({ mailboxId, onStarted }: { mailboxId: string | null; onStarted: () => void }) {
	const [form, setFormState] = useState<ImapFormState>(initialImapForm);
	const [plan, setPlan] = useState<AccountPlan | null>(null);
	const [kiteFolders, setKiteFolders] = useState<ImportFolderSummary[]>([]);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [started, setStarted] = useState<string | null>(null);
	const [sizeConfirmRequired, setSizeConfirmRequired] = useState(false);
	const [importAnyway, setImportAnyway] = useState(false);
	const account = form.mode === "account";

	function setForm(next: ImapFormState) {
		// A plan belongs to the account it was read from.
		if (next.host !== form.host || next.username !== form.username || next.port !== form.port) setPlan(null);
		setFormState(next);
	}

	async function run(task: () => Promise<void>) {
		setLoading(true);
		setError(null);
		setStarted(null);
		try {
			await task();
		} catch (taskError) {
			setError(taskError instanceof Error ? taskError.message : "IMAP import failed");
		} finally {
			setLoading(false);
		}
	}

	const loadPlan = () =>
		run(async () => {
			if (!mailboxId) throw new Error("Select a mailbox first");
			const [loaded, folders] = await Promise.all([fetchAccountPlan(form), fetchMailboxFolders(mailboxId)]);
			setKiteFolders(folders);
			setPlan(adoptExistingFolders(loaded, folders));
		});

	function onSubmit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		if (!mailboxId) return;
		void run(async () => {
			if (account && plan) await createAccountImportJob(mailboxId, form, plan.folders, importAnyway);
			else await createImapImportJob(mailboxId, form, form.destination, form.folder, importAnyway);
			setStarted(account ? "Started the import of the account." : `Started the import of ${form.folder}.`);
			setPlan(null);
			setFormState((current) => ({ ...current, password: "" }));
			onStarted();
		});
	}

	const messages = account ? (plan ? plannedMessageCount(plan.folders) : null) : estimatedImapMessages(form, 1);
	const canSubmit =
		canSubmitImap({
			form,
			hasMailbox: !!mailboxId,
			sources: account ? (plan?.folders.filter((folder) => folder.include).length ?? 0) : 1,
			loading,
			blockedBySize: sizeConfirmRequired && !importAnyway,
		}) &&
		(account || !!form.folder.trim());

	return (
		<form onSubmit={onSubmit} className="space-y-4">
			<ModeSelect form={form} setForm={setForm} />
			<CredentialFields form={form} setForm={setForm} />
			{account ? (
				<AccountFields
					plan={plan}
					kiteFolders={kiteFolders}
					loading={loading}
					canLoad={!!form.host && !!form.username && !!form.password && !!mailboxId}
					onLoad={() => void loadPlan()}
					onChange={(folders) => setPlan(plan ? { ...plan, folders } : plan)}
				/>
			) : (
				<FolderFields form={form} setForm={setForm} />
			)}
			<ImportSizeNotice
				messages={messages}
				importAnyway={importAnyway}
				onImportAnywayChange={setImportAnyway}
				onRequiresConfirmation={setSizeConfirmRequired}
			/>
			{(!account || plan) && (
				<Button type="submit" disabled={!canSubmit}>
					<Upload className="h-4 w-4" />
					{loading ? "Starting..." : account ? "Import account" : "Import folder"}
				</Button>
			)}
			<Feedback started={started} error={error} />
		</form>
	);
}

function ModeSelect({ form, setForm }: FormProps) {
	return (
		<div className="space-y-2">
			<Label htmlFor="imap-mode">What to import</Label>
			<Select
				id="imap-mode"
				value={form.mode}
				onChange={(event) => setForm({ ...form, mode: event.target.value as ImapImportMode })}
			>
				<option value="account">Whole account</option>
				<option value="folder">One folder</option>
			</Select>
		</div>
	);
}

function CredentialFields({ form, setForm }: FormProps) {
	return (
		<>
			<div className="grid gap-3 md:grid-cols-[1fr_110px]">
				<div className="space-y-2">
					<Label htmlFor="imap-host">Host</Label>
					<Input
						id="imap-host"
						value={form.host}
						onChange={(event) => setForm({ ...form, host: event.target.value })}
						placeholder="imap.gmail.com"
					/>
				</div>
				<div className="space-y-2">
					<Label htmlFor="imap-port">Port</Label>
					<Input
						id="imap-port"
						type="number"
						value={form.port}
						onChange={(event) => setForm({ ...form, port: event.target.value })}
					/>
				</div>
			</div>
			<div className="grid gap-3 md:grid-cols-2">
				<div className="space-y-2">
					<Label htmlFor="imap-username">Username</Label>
					<Input
						id="imap-username"
						value={form.username}
						onChange={(event) => setForm({ ...form, username: event.target.value })}
						placeholder="you@example.com"
					/>
				</div>
				<div className="space-y-2">
					<Label htmlFor="imap-password">Password or app password</Label>
					<Input
						id="imap-password"
						type="password"
						value={form.password}
						onChange={(event) => setForm({ ...form, password: event.target.value })}
						autoComplete="off"
					/>
				</div>
			</div>
			<div className="space-y-2">
				<Label htmlFor="imap-security">Encryption</Label>
				<Select
					id="imap-security"
					value={imapSecurityValue(form)}
					onChange={(event) => setForm(withImapSecurity(form, event.target.value === "tls"))}
				>
					<option value="tls">TLS (port 993)</option>
					<option value="starttls">STARTTLS (port 143)</option>
				</Select>
				<p className="text-xs text-neutral-500">
					Kite only connects over an encrypted connection and checks the server&apos;s certificate.
				</p>
			</div>
		</>
	);
}

function FolderFields({ form, setForm }: FormProps) {
	return (
		<div className="grid gap-3 md:grid-cols-2">
			<div className="space-y-2">
				<Label htmlFor="imap-folder">Source folder</Label>
				<Input
					id="imap-folder"
					value={form.folder}
					onChange={(event) => setForm({ ...form, folder: event.target.value })}
				/>
			</div>
			<div className="space-y-2">
				<Label htmlFor="imap-destination">Goes to</Label>
				<Select
					id="imap-destination"
					value={form.destination}
					onChange={(event) => setForm({ ...form, destination: event.target.value })}
				>
					{systemDestinations.map((option) => (
						<option key={option.value} value={option.value}>
							{option.label}
						</option>
					))}
				</Select>
			</div>
			<div className="space-y-2" hidden={form.importAll}>
				<Label htmlFor="imap-limit">Message limit</Label>
				<Input
					id="imap-limit"
					type="number"
					min={1}
					max={10000}
					value={form.limit}
					onChange={(event) => setForm({ ...form, limit: event.target.value })}
				/>
			</div>
			<label className="flex items-end gap-2 pb-2 text-sm text-neutral-700">
				<Checkbox
					checked={form.importAll}
					onChange={(event) => setForm({ ...form, importAll: event.target.checked })}
				/>
				Import all messages (newest first)
			</label>
		</div>
	);
}

function AccountFields(props: {
	plan: AccountPlan | null;
	kiteFolders: ImportFolderSummary[];
	loading: boolean;
	canLoad: boolean;
	onLoad: () => void;
	onChange: (folders: AccountPlan["folders"]) => void;
}) {
	return (
		<div className="space-y-3">
			<p className="rounded-lg bg-neutral-50 px-4 py-3 text-xs leading-5 text-neutral-500">
				Kite lists the account&apos;s folders and proposes where each one goes: Inbox, Sent and Archive to the same
				places in Kite, your own folders to Kite folders of the same name. Spam and Trash are left out unless you tick
				them. Mail already in Kite is skipped, and read and starred state is kept.
			</p>
			<Button type="button" variant="outline" disabled={!props.canLoad || props.loading} onClick={props.onLoad}>
				{props.plan ? "Read folders again" : "Show folders"}
			</Button>
			{props.plan && (
				<AccountMappingTable plan={props.plan} kiteFolders={props.kiteFolders} onChange={props.onChange} />
			)}
		</div>
	);
}

function Feedback({ started, error }: { started: string | null; error: string | null }) {
	return (
		<>
			{started && (
				<p className="rounded-lg border border-[#22c55e]/25 bg-[#22c55e]/10 px-4 py-3 text-sm text-[#166534] dark:text-[#86c99d]">
					{started} Progress is shown below.
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
		</>
	);
}
