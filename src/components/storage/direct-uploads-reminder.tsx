"use client";

import { useState } from "react";
import Link from "next/link";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Notice } from "@/components/ui/notice";
import { authFetch } from "@/lib/auth/client";
import {
	DIRECT_UPLOADS_REMINDER_TITLE,
	DIRECT_UPLOADS_WHY,
	directUploadsAttemptText,
	type DirectUploadsReminderData,
} from "./direct-uploads-reminder-utils";

export type { DirectUploadsReminderData };

/** Shared with the Storage page's own query, so dismissing in one place hides it in the other. */
export const STORAGE_OVERVIEW_KEY = ["admin-storage"];

/** The storage overview (primary admin only), for the reminder's own reads. */
export async function fetchStorageReminder(): Promise<{ directUploadsReminder?: DirectUploadsReminderData }> {
	const response = await authFetch("/api/admin/storage");
	if (!response.ok) throw new Error(`Storage overview failed (${response.status})`);
	return (await response.json()) as { directUploadsReminder?: DirectUploadsReminderData };
}

/** Hides the reminder for the install, on the Storage page and the Admin overview alike. */
export async function dismissDirectUploadsReminder(): Promise<void> {
	const response = await authFetch("/api/admin/storage/reminder", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ dismissed: true }),
	});
	if (!response.ok) throw new Error("Could not dismiss the reminder");
}

/**
 * "Direct uploads are off": the default on Cloudflare is that Drive uploads go straight to R2, so until they do the
 * owner sees this on the Storage page and the Admin overview, with why the automatic setup failed, until dismissed.
 */
export function DirectUploadsReminder({
	reminder,
	onSetUp,
	setUpHref,
}: {
	reminder: DirectUploadsReminderData;
	/** Opens the setup on the same page; otherwise `setUpHref` links to it. */
	onSetUp?: () => void;
	setUpHref?: string;
}) {
	const queryClient = useQueryClient();
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	if (!reminder.show) return null;
	const attempt = directUploadsAttemptText(reminder.setup);
	async function hide() {
		setBusy(true);
		setError(null);
		try {
			await dismissDirectUploadsReminder();
			await queryClient.invalidateQueries({ queryKey: STORAGE_OVERVIEW_KEY });
		} catch (caught) {
			setError(caught instanceof Error ? caught.message : "Could not dismiss the reminder");
		} finally {
			setBusy(false);
		}
	}
	return (
		<div data-direct-uploads-reminder>
			<Notice
				tone={attempt ? "warning" : "info"}
				title={DIRECT_UPLOADS_REMINDER_TITLE}
				actions={
					<>
						{onSetUp ? (
							<Button size="sm" onClick={onSetUp}>
								Set up
							</Button>
						) : (
							<Button size="sm" asChild>
								<Link href={setUpHref ?? "/storage?setup=direct"}>Set up</Link>
							</Button>
						)}
						<Button size="sm" variant="outline" disabled={busy} onClick={() => void hide()}>
							Dismiss
						</Button>
					</>
				}
			>
				<p>{DIRECT_UPLOADS_WHY}</p>
				{attempt && <p className="mt-1">{attempt}</p>}
				{error && <p className="mt-1 text-red-700">{error}</p>}
			</Notice>
		</div>
	);
}
