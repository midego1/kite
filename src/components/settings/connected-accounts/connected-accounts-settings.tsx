"use client";

import Link from "next/link";
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link2, Plus } from "lucide-react";
import { useSelectedMailbox } from "@/components/mailbox-provider";
import { useModules } from "@/components/modules/modules-context";
import { SUCCESS_NOTICE_CLASS, WARNING_NOTICE_CLASS } from "@/components/notice-styles";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { EmptyState, PageHeader } from "@/components/ui/page";
import type { ExternalAccountView } from "@/lib/external-accounts/types";
import { AccountFormDialog } from "./account-form-dialog";
import type { ConnectedAccountsState } from "./connected-accounts-types";
import {
	canCheckNow,
	showLastError,
	checkAccountNow,
	CONNECTED_ACCOUNTS_QUERY_KEY,
	fetchConnectedAccounts,
	removeAccount,
	setAccountChecking,
	STATUS_LABELS,
	statusHint,
	syncStatusText,
	testAccount,
} from "./connected-accounts-utils";

type Editing = { account: ExternalAccountView | null } | null;

/** Settings → Connected accounts: the user's external accounts, connect, test, edit and remove. */
export function ConnectedAccountsSettings() {
	const queryClient = useQueryClient();
	const { data, error } = useQuery({
		queryKey: CONNECTED_ACCOUNTS_QUERY_KEY,
		queryFn: fetchConnectedAccounts,
		refetchOnWindowFocus: false,
		// While a check runs, the list follows it until it is done.
		refetchInterval: (query) => (query.state.data?.accounts.some((account) => account.sync.running) ? 3_000 : 60_000),
	});
	const [editing, setEditing] = useState<Editing>(null);
	const [notice, setNotice] = useState<{ text: string; accountId?: string } | null>(null);
	const refresh = () => queryClient.invalidateQueries({ queryKey: CONNECTED_ACCOUNTS_QUERY_KEY });
	const allowed = !!data && !data.refusal;

	return (
		<div className="space-y-6">
			<PageHeader
				title="Connected accounts"
				description="Connect a Gmail, iCloud, Fastmail, Yahoo or other IMAP account: Kite checks its Inbox for new mail every few minutes and can import the mail already there."
				actions={
					allowed && (
						<Button onClick={() => setEditing({ account: null })}>
							<Plus className="h-4 w-4" />
							Connect account
						</Button>
					)
				}
			/>
			{data?.refusalText && (
				<p role="status" className={WARNING_NOTICE_CLASS}>
					{data.refusalText}
				</p>
			)}
			{error && (
				<p role="alert" className="text-sm text-red-600">
					{error.message}
				</p>
			)}
			{notice && <ConnectedNotice text={notice.text} accountId={notice.accountId} />}
			{data && <AccountList data={data} onEdit={(account) => setEditing({ account })} onChanged={refresh} />}
			{editing && data && (
				<AccountFormDialog
					open
					onOpenChange={(open) => !open && setEditing(null)}
					account={editing.account}
					presets={data.presets}
					onSaved={(account, connected) => {
						setEditing(null);
						setNotice({
							text: connected ? `Connected ${account.address}.` : `Saved ${account.address}.`,
							accountId: connected ? account.id : undefined,
						});
						void refresh();
					}}
				/>
			)}
		</div>
	);
}

function ConnectedNotice({ text, accountId }: { text: string; accountId?: string }) {
	const { isEnabled } = useModules();
	return (
		<p role="status" className={SUCCESS_NOTICE_CLASS}>
			{text}
			{accountId && isEnabled("import") && (
				<>
					{" "}
					<Link
						className="underline underline-offset-2"
						href={`/settings/import?account=${encodeURIComponent(accountId)}`}
					>
						Import existing mail
					</Link>
				</>
			)}
		</p>
	);
}

function AccountList({
	data,
	onEdit,
	onChanged,
}: {
	data: ConnectedAccountsState;
	onEdit: (account: ExternalAccountView) => void;
	onChanged: () => void;
}) {
	if (data.migrationPending) return null;
	if (!data.accounts.length)
		return (
			<EmptyState
				icon={Link2}
				title="No connected accounts"
				description="Connect an account to bring in its new mail and import what is already there. Kite signs in over an encrypted connection and never changes anything at the provider."
			/>
		);
	return (
		<ul
			className="divide-y divide-neutral-200 rounded-xl border border-neutral-200 bg-white"
			aria-label="Connected accounts"
		>
			{data.accounts.map((account) => (
				<AccountRow
					key={account.id}
					account={account}
					usable={!data.refusal}
					onEdit={() => onEdit(account)}
					onChanged={onChanged}
				/>
			))}
		</ul>
	);
}

function AccountRow({
	account,
	usable,
	onEdit,
	onChanged,
}: {
	account: ExternalAccountView;
	usable: boolean;
	onEdit: () => void;
	onChanged: () => void;
}) {
	const confirm = useConfirm();
	const [busy, setBusy] = useState(false);
	const [message, setMessage] = useState<string | null>(null);

	async function act(task: () => Promise<string | null>) {
		setBusy(true);
		setMessage(null);
		try {
			setMessage(await task());
			onChanged();
		} catch (error) {
			setMessage(error instanceof Error ? error.message : "Something went wrong");
		} finally {
			setBusy(false);
		}
	}

	const actions: AccountActionHandlers = {
		test: () =>
			act(async () => {
				const outcome = await testAccount(account.id);
				return outcome.problem ? outcome.problem.message : "The connection works.";
			}),
		checkNow: () =>
			act(async () => {
				await checkAccountNow(account.id);
				return "Checking for new mail…";
			}),
		toggleChecking: () =>
			act(async () => {
				await setAccountChecking(account.id, !account.sync.enabled);
				return account.sync.enabled ? "Checking paused." : "Checking resumed.";
			}),
		remove: () =>
			act(async () => {
				const confirmed = await confirm({
					title: `Remove ${account.address}?`,
					description:
						"Kite forgets the account and its saved password. Mail already in Kite stays where it is, and nothing changes at the provider.",
					confirmLabel: "Remove",
				});
				if (!confirmed) return null;
				await removeAccount(account.id);
				return null;
			}),
		edit: onEdit,
	};

	return (
		<li className="flex flex-wrap items-start justify-between gap-3 p-4" data-external-account={account.address}>
			<AccountDetails account={account} message={message} />
			<AccountActions account={account} usable={usable} busy={busy} actions={actions} />
		</li>
	);
}

function AccountDetails({ account, message }: { account: ExternalAccountView; message: string | null }) {
	const { mailboxes } = useSelectedMailbox();
	const mailbox = mailboxes.find((entry) => entry.id === account.mailboxId);
	const hint = statusHint(account);
	const syncText = syncStatusText(account, new Date());
	return (
		<div className="min-w-0 space-y-1">
			<div className="flex flex-wrap items-center gap-2">
				<p className="truncate text-sm font-semibold text-neutral-900">{account.label}</p>
				<Badge variant={account.status === "active" ? "success" : "outline"}>{STATUS_LABELS[account.status]}</Badge>
			</div>
			<p className="text-xs text-neutral-500">
				{account.address} · {account.presetLabel}
				{mailbox ? ` · Mail goes to ${mailbox.displayName || `${mailbox.localPart}@${mailbox.hostname}`}` : ""}
			</p>
			{hint && <p className="text-xs text-[#8a4b0a] dark:text-[#d4a35a]">{hint}</p>}
			{syncText && (
				<p className="text-xs text-neutral-600" data-sync-status>
					{syncText}
				</p>
			)}
			{showLastError(account, syncText) && <p className="text-xs text-neutral-500">{account.lastError}</p>}
			{message && (
				<p role="status" className="text-xs text-neutral-700">
					{message}
				</p>
			)}
		</div>
	);
}

type AccountActionHandlers = Record<"test" | "checkNow" | "toggleChecking" | "remove" | "edit", () => void>;

function AccountActions({
	account,
	usable,
	busy,
	actions,
}: {
	account: ExternalAccountView;
	usable: boolean;
	busy: boolean;
	actions: AccountActionHandlers;
}) {
	const { isEnabled } = useModules();
	const checked = account.status === "active" || account.status === "error";
	return (
		<div className="flex flex-wrap items-center gap-2">
			{usable && isEnabled("import") && account.status === "active" && (
				<Button asChild size="sm" variant="outline">
					<Link href={`/settings/import?account=${encodeURIComponent(account.id)}`}>Import mail</Link>
				</Button>
			)}
			{usable && canCheckNow(account) && (
				<Button size="sm" variant="outline" disabled={busy || account.sync.running} onClick={actions.checkNow}>
					Check now
				</Button>
			)}
			{usable && checked && account.hasPassword && (
				<Button size="sm" variant="outline" disabled={busy} onClick={actions.toggleChecking}>
					{account.sync.enabled ? "Pause" : "Resume"}
				</Button>
			)}
			{usable && (
				<Button size="sm" variant="outline" disabled={busy || !account.hasPassword} onClick={actions.test}>
					Test connection
				</Button>
			)}
			<Button size="sm" variant="outline" disabled={busy || !usable} onClick={actions.edit}>
				{account.status === "active" ? "Edit" : "Reconnect"}
			</Button>
			<Button size="sm" variant="outline" disabled={busy} onClick={actions.remove}>
				Remove
			</Button>
		</div>
	);
}
