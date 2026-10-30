"use client";

import { useState } from "react";
import Link from "next/link";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Notice } from "@/components/ui/notice";
import { authFetch } from "@/lib/auth/client";

export type DirectUploadsReminderData = {
	show: boolean;
	setup: { ok: boolean; source: "install" | "admin"; message?: string; permission?: string | null } | null;
};

/** Shared with the Storage page's own query, so dismissing in one place hides it in the other. */
const STORAGE_OVERVIEW_KEY = ["admin-storage"];

/** Why the last automatic setup did not finish, in one sentence; nothing when it never ran. */
function lastAttempt(setup: DirectUploadsReminderData["setup"]): string | null {
	if (!setup || setup.ok) return null;
	const when = setup.source === "install" ? "during installation" : "last time";
	const permission = setup.permission ? ` CF_TOKEN needs "${setup.permission}".` : "";
	return `The automatic setup ${when} did not finish: ${setup.message ?? "it failed"}${permission}`;
}

async function dismiss(): Promise<void> {
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
	const attempt = lastAttempt(reminder.setup);
	async function hide() {
		setBusy(true);
		setError(null);
		try {
			await dismiss();
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
				title="Direct uploads are off: set up (2 min)"
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
				<p>
					Large Drive uploads pass through the Worker. With direct uploads they go straight to R2: faster, and less load
					on the Worker.
				</p>
				{attempt && <p className="mt-1">{attempt}</p>}
				{error && <p className="mt-1 text-red-700">{error}</p>}
			</Notice>
		</div>
	);
}

/** The Admin overview's copy: reads the storage overview (primary admin only; anyone else gets nothing). */
export function AdminDirectUploadsReminder() {
	const overview = useQuery({
		queryKey: STORAGE_OVERVIEW_KEY,
		queryFn: async () => {
			const response = await authFetch("/api/admin/storage");
			if (!response.ok) throw new Error(`Storage overview failed (${response.status})`);
			return (await response.json()) as { directUploadsReminder?: DirectUploadsReminderData };
		},
		retry: false,
	});
	const reminder = overview.data?.directUploadsReminder;
	return reminder ? <DirectUploadsReminder reminder={reminder} /> : null;
}
