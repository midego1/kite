"use client";

import { useEffect, useState } from "react";
import { authFetch } from "@/lib/auth/client";
import { TRASH_RETENTION_OPTIONS, describeTrashRetention } from "@/lib/email/trash-retention-utils";
import type { TrashRetentionSettingsResponse } from "@/app/api/settings/trash-retention/types";

export function TrashRetentionSettings() {
	const [days, setDays] = useState<number | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		void authFetch("/api/settings/trash-retention")
			.then(async (response) => {
				const data = (await response.json()) as TrashRetentionSettingsResponse;
				if (!response.ok)
					throw new Error(typeof data.error === "string" ? data.error : "Failed to load clean-up settings");
				setDays(data.days ?? null);
			})
			.catch((nextError) =>
				setError(nextError instanceof Error ? nextError.message : "Failed to load clean-up settings"),
			)
			.finally(() => setLoading(false));
	}, []);

	async function updateDays(nextDays: number | null) {
		const previous = days;
		setDays(nextDays);
		setLoading(true);
		setError(null);
		try {
			const response = await authFetch("/api/settings/trash-retention", {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ days: nextDays }),
			});
			const data = (await response.json()) as TrashRetentionSettingsResponse;
			if (!response.ok)
				throw new Error(typeof data.error === "string" ? data.error : "Failed to update clean-up settings");
			setDays(data.days ?? null);
		} catch (nextError) {
			setDays(previous);
			setError(nextError instanceof Error ? nextError.message : "Failed to update clean-up settings");
		} finally {
			setLoading(false);
		}
	}

	// Keep a custom value set through the API selectable instead of silently showing "Never".
	const options: number[] =
		days && !(TRASH_RETENTION_OPTIONS as readonly number[]).includes(days)
			? [...TRASH_RETENTION_OPTIONS, days].sort((a, b) => a - b)
			: [...TRASH_RETENTION_OPTIONS];

	return (
		<div>
			<label className="flex items-start gap-3 rounded-xl bg-neutral-50 p-4">
				<span className="flex-1">
					<span className="block text-sm font-medium text-neutral-900">Auto-delete Trash and Spam</span>
					<span className="mt-1 block text-sm text-neutral-500">
						Permanently delete messages once they have been in Trash or Spam for this long. Applies to the mailboxes you
						own.
					</span>
				</span>
				<select
					value={days ?? ""}
					disabled={loading}
					onChange={(event) => void updateDays(event.target.value ? Number(event.target.value) : null)}
					className="rounded-lg border border-neutral-200 bg-white px-3 py-1.5 text-sm text-neutral-800 disabled:opacity-60"
					aria-label="Auto-delete Trash and Spam"
				>
					<option value="">{describeTrashRetention(null)}</option>
					{options.map((value) => (
						<option key={value} value={value}>
							{describeTrashRetention(value)}
						</option>
					))}
				</select>
			</label>
			{error && <p className="mt-2 px-4 text-sm text-red-600">{error}</p>}
		</div>
	);
}
