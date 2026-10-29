"use client";

import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { restoreOutcomeText } from "@/lib/backups/restore-job-utils";
import { fetchRestoreSummary, restoreBackup, restoreStoredBackup } from "./utils";

/** A restore replaces the sessions too, so sign in again. */
const signInAgain = () => window.location.assign("/login");

/**
 * Starts a restore (an uploaded file or a stored backup) and follows the queued job until it ends: a completed
 * restore signs in again, since the restored sessions replace the current one, and a failed one shows why. While it
 * runs the session usually disappears with the sessions table, and the 401 that follows signs in again too
 * (authFetch). A restore already running when the page opens is shown as running.
 */
export function useRestoreJob() {
	const [followed, setFollowed] = useState<string | null>(null);
	const upload = useMutation({ mutationFn: restoreBackup, onSuccess: setFollowed });
	const stored = useMutation({ mutationFn: restoreStoredBackup, onSuccess: setFollowed });
	const status = useQuery({
		queryKey: ["backup-restore", followed],
		queryFn: fetchRestoreSummary,
		refetchInterval: (query) => (query.state.data?.active || (followed && !query.state.data) ? 2000 : false),
	});
	const restore = status.data ?? null;
	const ended = restore && followed === restore.id && !restore.active ? restore : null;
	const completed = ended?.status === "completed";

	useEffect(() => {
		if (completed) signInAgain();
	}, [completed]);

	const outcome = ended ? restoreOutcomeText(ended) : null;
	return {
		restoreUpload: upload.mutate,
		restoreStored: stored.mutate,
		running: upload.isPending || stored.isPending || !!restore?.active || completed,
		error: upload.error ?? stored.error ?? (outcome ? new Error(outcome) : null),
	};
}
