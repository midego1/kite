"use client";

import { useCallback, useEffect, useState } from "react";
import clsx from "clsx";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { formatDriveSize } from "@/lib/drive/name-utils";
import { driveRequest } from "./drive-api";
import { parseQuotaGb, quotaToGb, usagePercent } from "./drive-utils";

type Account = {
	id: string;
	name: string;
	email: string;
	disabled: boolean;
	used: number;
	override: { quotaBytes: number | null } | null;
	limit: number | null;
	editable: boolean;
};

type UsagePage = { accounts: Account[]; nextCursor: string | null };

function QuotaEditor({ account, onChanged }: { account: Account; onChanged: () => void }) {
	const [value, setValue] = useState(account.override ? quotaToGb(account.override.quotaBytes) : "");
	const [error, setError] = useState<string | null>(null);
	const url = `/api/drive/settings/quotas/${encodeURIComponent(account.id)}`;

	async function run(request: () => Promise<unknown>) {
		setError(null);
		try {
			await request();
			onChanged();
		} catch (failure) {
			setError(failure instanceof Error ? failure.message : "Could not save");
		}
	}

	function save() {
		const quota = parseQuotaGb(value);
		if ("error" in quota) return setError(quota.error);
		void run(() => driveRequest(url, { method: "PUT", body: { quotaBytes: quota.bytes } }));
	}

	return (
		<div className="flex flex-wrap items-center gap-2">
			<Input
				aria-label={`Storage override for ${account.email} (GB)`}
				inputMode="decimal"
				placeholder="Unlimited"
				value={value}
				onChange={(event) => setValue(event.target.value)}
				className="h-8 w-28"
			/>
			<Button type="button" size="sm" variant="outline" onClick={save}>
				Set
			</Button>
			{account.override && (
				<Button
					type="button"
					size="sm"
					variant="ghost"
					onClick={() => void run(() => driveRequest(url, { method: "DELETE" }))}
				>
					Use default
				</Button>
			)}
			{error && <span className="w-full text-xs text-red-600">{error}</span>}
		</div>
	);
}

function AccountRow({ account, onChanged }: { account: Account; onChanged: () => void }) {
	const percent = usagePercent(account.used, account.limit);
	return (
		<li className="grid gap-3 py-3 text-sm md:grid-cols-[minmax(0,1fr)_12rem_minmax(0,16rem)] md:items-center">
			<span className="min-w-0">
				<span className="block truncate font-medium text-neutral-900">{account.name || account.email}</span>
				<span className="block truncate text-xs text-neutral-500">
					{account.email}
					{account.disabled ? " · disabled" : ""}
				</span>
			</span>
			<span>
				<span className="mb-1 block text-xs text-neutral-600">
					{formatDriveSize(account.used)}
					{account.limit === null ? " · unlimited" : ` of ${formatDriveSize(account.limit)}`}
				</span>
				<span className="block h-1.5 overflow-hidden rounded-full bg-neutral-200" aria-hidden="true">
					<span
						className={clsx("block h-full rounded-full", percent >= 90 ? "bg-red-500" : "bg-blue-600")}
						style={{ width: `${percent}%` }}
					/>
				</span>
			</span>
			{account.editable ? (
				<QuotaEditor key={JSON.stringify(account.override)} account={account} onChanged={onChanged} />
			) : (
				<span className="text-xs text-neutral-500">Only the owner can change this account</span>
			)}
		</li>
	);
}

/** Every account's Drive usage, with a per-account storage override. */
export function DriveUsageTable({ reloadKey }: { reloadKey: number }) {
	const [pages, setPages] = useState<UsagePage[]>([]);
	const [error, setError] = useState<string | null>(null);

	const load = useCallback(async (cursor: string | null) => {
		try {
			const page = await driveRequest<UsagePage>(
				`/api/drive/settings/usage${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`,
			);
			setPages((current) => (cursor ? [...current, page] : [page]));
		} catch (failure) {
			setError(failure instanceof Error ? failure.message : "Could not load usage");
		}
	}, []);

	useEffect(() => {
		// Fetching from the server is the external system this effect synchronizes with.
		// eslint-disable-next-line react-hooks/set-state-in-effect
		void load(null);
	}, [load, reloadKey]);

	const accounts = pages.flatMap((page) => page.accounts);
	const nextCursor = pages.at(-1)?.nextCursor ?? null;

	return (
		<Card>
			<CardHeader>
				<CardTitle>Accounts</CardTitle>
			</CardHeader>
			<CardContent className="pt-4">
				{error && <p className="text-sm text-red-600">{error}</p>}
				<ul className="divide-y divide-neutral-200" data-drive-usage-table>
					{accounts.map((account) => (
						<AccountRow key={account.id} account={account} onChanged={() => void load(null)} />
					))}
				</ul>
				{nextCursor && (
					<Button type="button" variant="ghost" size="sm" onClick={() => void load(nextCursor)}>
						Show more accounts
					</Button>
				)}
			</CardContent>
		</Card>
	);
}
