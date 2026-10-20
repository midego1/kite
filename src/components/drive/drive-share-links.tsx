"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import toast from "react-hot-toast";
import { Copy, Lock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { DriveLinkDto } from "@/lib/drive/types";
import { driveRequest } from "./drive-api";
import { formatDriveDate } from "./drive-utils";

type LinksAnswer = { links: DriveLinkDto[]; linkMaxDays: number };

function linkStatus(link: DriveLinkDto): string {
	if (link.revokedAt) return "Revoked";
	if (!link.active) return "Expired";
	return `Expires ${formatDriveDate(link.expiresAt)}`;
}

function LinkRow({ link, onRevoke }: { link: DriveLinkDto; onRevoke: (link: DriveLinkDto) => void }) {
	const copy = () =>
		void navigator.clipboard.writeText(link.url ?? "").then(
			() => toast.success("Link copied"),
			() => toast.error("Could not copy the link"),
		);
	return (
		<li className="space-y-1.5 py-2.5 text-sm" data-drive-link={link.active ? "active" : "inactive"}>
			<div className="flex items-center gap-2">
				{link.hasPassword && <Lock size={14} className="shrink-0 text-neutral-500" aria-label="Password protected" />}
				<span className="min-w-0 flex-1 truncate text-neutral-900">{link.url ?? "Link (shown once when created)"}</span>
				{link.active && link.url && (
					<button
						type="button"
						onClick={copy}
						aria-label="Copy link"
						className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-neutral-600 hover:bg-neutral-100"
					>
						<Copy size={15} />
					</button>
				)}
				{link.active && (
					<Button type="button" size="sm" variant="outline" onClick={() => onRevoke(link)}>
						Revoke
					</Button>
				)}
			</div>
			<p className="text-xs text-neutral-500">
				{linkStatus(link)} · {link.downloadCount} {link.downloadCount === 1 ? "download" : "downloads"}
				{link.lastAccessedAt ? ` · last opened ${formatDriveDate(link.lastAccessedAt)}` : ""}
			</p>
		</li>
	);
}

function NewLinkForm({
	maxDays,
	onCreate,
}: {
	maxDays: number;
	onCreate: (days: number, password: string) => Promise<boolean>;
}) {
	const [days, setDays] = useState(String(Math.min(7, maxDays)));
	const [password, setPassword] = useState("");
	const [busy, setBusy] = useState(false);

	async function submit(event: FormEvent) {
		event.preventDefault();
		setBusy(true);
		if (await onCreate(Number(days), password)) setPassword("");
		setBusy(false);
	}

	return (
		<form onSubmit={(event) => void submit(event)} className="flex flex-wrap items-end gap-2">
			<label className="space-y-1 text-xs text-neutral-600">
				<span className="block">Expires after (days)</span>
				<Input
					type="number"
					min={1}
					max={maxDays}
					required
					value={days}
					onChange={(event) => setDays(event.target.value)}
					className="h-9 w-28"
				/>
			</label>
			<label className="min-w-40 flex-1 space-y-1 text-xs text-neutral-600">
				<span className="block">Password (optional)</span>
				<Input
					type="password"
					autoComplete="new-password"
					maxLength={200}
					value={password}
					onChange={(event) => setPassword(event.target.value)}
					className="h-9"
				/>
			</label>
			<Button type="submit" size="sm" className="h-9" disabled={busy}>
				Create link
			</Button>
		</form>
	);
}

/** Public links of an item you own: each expires, may need a password, and can be revoked. */
export function DriveShareLinks({ itemId, onChanged }: { itemId: string; onChanged: () => void }) {
	const base = `/api/drive/items/${encodeURIComponent(itemId)}/links`;
	const [answer, setAnswer] = useState<LinksAnswer | null>(null);
	const [error, setError] = useState<string | null>(null);

	const reload = useCallback(
		() =>
			driveRequest<LinksAnswer>(base)
				.then(setAnswer)
				.catch((failure: unknown) => setError(failure instanceof Error ? failure.message : "Could not load links")),
		[base],
	);

	useEffect(() => {
		void reload();
	}, [reload]);

	async function create(days: number, password: string) {
		setError(null);
		try {
			const { link } = await driveRequest<{ link: DriveLinkDto }>(base, {
				method: "POST",
				body: { expiresInDays: days, ...(password ? { password } : {}) },
			});
			setAnswer((previous) => previous && { ...previous, links: [link, ...previous.links] });
			onChanged();
			return true;
		} catch (failure) {
			setError(failure instanceof Error ? failure.message : "Could not create the link");
			return false;
		}
	}

	async function revoke(link: DriveLinkDto) {
		try {
			await driveRequest(`/api/drive/links/${encodeURIComponent(link.id)}`, { method: "DELETE" });
			await reload();
			onChanged();
		} catch (failure) {
			setError(failure instanceof Error ? failure.message : "Could not revoke the link");
		}
	}

	return (
		<section aria-labelledby="drive-share-links" className="space-y-3">
			<h3 id="drive-share-links" className="text-sm font-semibold text-neutral-900">
				Public links
			</h3>
			{answer && answer.linkMaxDays === 0 && (
				<p className="text-sm text-neutral-500">An admin has turned public links off.</p>
			)}
			{answer && answer.linkMaxDays > 0 && <NewLinkForm maxDays={answer.linkMaxDays} onCreate={create} />}
			{error && (
				<p role="alert" className="text-sm text-red-600">
					{error}
				</p>
			)}
			<ul className="divide-y divide-neutral-100">
				{(answer?.links ?? []).map((link) => (
					<LinkRow key={link.id} link={link} onRevoke={(target) => void revoke(target)} />
				))}
			</ul>
		</section>
	);
}
