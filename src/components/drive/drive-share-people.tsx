"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { DriveRole, DriveShareDto, DriveShareRole } from "@/lib/drive/types";
import { driveRequest } from "./drive-api";

type Candidate = { id: string; name: string; email: string };
type SharesAnswer = { shares: DriveShareDto[]; candidates?: Candidate[]; role?: DriveRole };

const selectClass =
	"h-9 rounded-lg border border-neutral-200 bg-white px-2 text-sm text-neutral-800 focus:outline-none focus:ring-2 focus:ring-blue-500";

function ShareRow({
	share,
	canChange,
	onRemove,
}: {
	share: DriveShareDto;
	canChange: boolean;
	onRemove: (share: DriveShareDto) => void;
}) {
	return (
		<li className="flex items-center gap-3 py-2 text-sm">
			<span className="min-w-0 flex-1">
				<span className="block truncate font-medium text-neutral-900">{share.name || share.email}</span>
				<span className="block truncate text-xs text-neutral-500">{share.email}</span>
			</span>
			<span className="shrink-0 text-xs text-neutral-600">{share.role === "edit" ? "Can edit" : "Can view"}</span>
			{canChange && (
				<button
					type="button"
					onClick={() => onRemove(share)}
					aria-label={`Stop sharing with ${share.email}`}
					className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-neutral-500 hover:bg-neutral-100"
				>
					<X size={16} />
				</button>
			)}
		</li>
	);
}

/** People with access: owners and editors may share with view; only the owner grants or removes edit. */
export function DriveSharePeople({ itemId, onChanged }: { itemId: string; onChanged: () => void }) {
	const base = `/api/drive/items/${encodeURIComponent(itemId)}/shares`;
	const [answer, setAnswer] = useState<SharesAnswer | null>(null);
	const [email, setEmail] = useState("");
	const [role, setRole] = useState<DriveShareRole>("view");
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

	const run = useCallback(
		async (request: Promise<SharesAnswer>, changed: boolean) => {
			setError(null);
			try {
				const next = await request;
				setAnswer((previous) => ({ ...previous, ...next }));
				if (changed) onChanged();
				return true;
			} catch (failure) {
				setError(failure instanceof Error ? failure.message : "Something went wrong");
				return false;
			}
		},
		[onChanged],
	);

	useEffect(() => {
		// Fetching from the server is the external system this effect synchronizes with.
		// eslint-disable-next-line react-hooks/set-state-in-effect
		void run(driveRequest<SharesAnswer>(base), false);
	}, [base, run]);

	async function add(event: FormEvent) {
		event.preventDefault();
		if (!email.trim()) return;
		setBusy(true);
		if (await run(driveRequest<SharesAnswer>(base, { method: "POST", body: { email, role } }), true)) setEmail("");
		setBusy(false);
	}

	const owner = answer?.role === "owner";
	const remove = (share: DriveShareDto) =>
		void run(driveRequest<SharesAnswer>(`${base}?shareId=${encodeURIComponent(share.id)}`, { method: "DELETE" }), true);

	return (
		<section aria-labelledby="drive-share-people" className="space-y-3">
			<h3 id="drive-share-people" className="text-sm font-semibold text-neutral-900">
				People with access
			</h3>
			<form onSubmit={(event) => void add(event)} className="flex gap-2">
				<Input
					aria-label="Email address"
					type="email"
					list="drive-share-candidates"
					placeholder="name@example.com"
					value={email}
					onChange={(event) => setEmail(event.target.value)}
					className="h-9 min-w-0 flex-1"
				/>
				<datalist id="drive-share-candidates">
					{(answer?.candidates ?? []).map((candidate) => (
						<option key={candidate.id} value={candidate.email}>
							{candidate.name}
						</option>
					))}
				</datalist>
				<select
					aria-label="Access"
					value={role}
					onChange={(event) => setRole(event.target.value as DriveShareRole)}
					className={selectClass}
				>
					<option value="view">Can view</option>
					{owner && <option value="edit">Can edit</option>}
				</select>
				<Button type="submit" size="sm" className="h-9" disabled={busy || !email.trim()}>
					Share
				</Button>
			</form>
			{error && (
				<p role="alert" className="text-sm text-red-600">
					{error}
				</p>
			)}
			{answer && answer.shares.length === 0 && <p className="text-sm text-neutral-500">Only you have access.</p>}
			<ul className="divide-y divide-neutral-100">
				{(answer?.shares ?? []).map((share) => (
					<ShareRow key={share.id} share={share} canChange={owner || share.role === "view"} onRemove={remove} />
				))}
			</ul>
		</section>
	);
}
