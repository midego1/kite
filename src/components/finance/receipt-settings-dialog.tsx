"use client";

import { useEffect, useRef, useState } from "react";
import toast from "react-hot-toast";
import { useModules } from "@/components/modules/modules-context";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { SettingRow } from "@/components/ui/page";
import { Switch } from "@/components/ui/switch";
import { authFetch } from "@/lib/auth/client";
import { useT } from "@/lib/i18n/use-t";

type BackfillStatus = { status: "running" | "done" | "failed"; filed: number; skipped: number; pending: number } | null;
type ReceiptSettings = { enabled: boolean; backfill: BackfillStatus };

/** How often the settings are read again while a backfill runs (matches the Payments scan poll). */
const BACKFILL_POLL_MS = 3_000;

/** `null` for any failure, a network error included: `authFetch` rejects when the request itself fails. */
async function fetchJson<T>(path: string, init?: RequestInit): Promise<T | null> {
	try {
		const response = await authFetch(path, init);
		return response.ok ? ((await response.json().catch(() => null)) as T | null) : null;
	} catch {
		return null;
	}
}

/** "Keep receipts": the per-user on/off switch and the "Save receipts for existing payments" backfill action. */
export function ReceiptSettingsDialog({
	open,
	onOpenChange,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	const t = useT();
	const { isEnabled } = useModules();
	const driveOn = isEnabled("drive");
	const [settings, setSettings] = useState<ReceiptSettings | null>(null);
	const [busy, setBusy] = useState(false);
	const [version, setVersion] = useState(0);
	const [loadFailed, setLoadFailed] = useState(false);
	// Counts the switch's own changes, and how many saves are in flight: a read that began before the latest change,
	// or that lands while one is still being saved, may carry the old `enabled` and must not put it back.
	const toggleGeneration = useRef(0);
	const savesInFlight = useRef(0);
	const running = settings?.backfill?.status === "running";

	useEffect(() => {
		if (!open || !driveOn) return;
		let live = true;
		const startedAt = toggleGeneration.current;
		void fetchJson<ReceiptSettings>("/api/finance/receipts").then((data) => {
			if (!live) return;
			if (!data) {
				// Keep what was last read (a poll that fails must not blank the dialog); Retry reads again.
				setLoadFailed(true);
				return;
			}
			setLoadFailed(false);
			const enabledIsStale = toggleGeneration.current !== startedAt || savesInFlight.current > 0;
			setSettings((current) => (current && enabledIsStale ? { ...data, enabled: current.enabled } : data));
		});
		return () => {
			live = false;
		};
	}, [open, driveOn, version]);

	useEffect(() => {
		if (!open || !running) return;
		const timer = window.setTimeout(() => setVersion((current) => current + 1), BACKFILL_POLL_MS);
		return () => window.clearTimeout(timer);
	}, [open, running, version]);

	async function toggle(next: boolean) {
		const generation = ++toggleGeneration.current;
		savesInFlight.current += 1;
		setSettings((current) => (current ? { ...current, enabled: next } : current));
		const saved = await fetchJson<{ enabled: boolean }>("/api/finance/receipts", {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ enabled: next }),
		});
		savesInFlight.current -= 1;
		if (!saved) {
			toast.error(t("Could not save the setting"));
			// Only undo this change when no later one replaced it.
			if (generation === toggleGeneration.current) {
				setSettings((current) => (current ? { ...current, enabled: !next } : current));
			}
		}
	}

	async function startBackfill() {
		setBusy(true);
		try {
			const result = await fetchJson<{ backfill: BackfillStatus }>("/api/finance/receipts/backfill", {
				method: "POST",
			});
			if (!result) {
				toast.error(t("Could not start"));
				return;
			}
			setSettings((current) => (current ? { ...current, backfill: result.backfill } : current));
		} finally {
			setBusy(false);
		}
	}

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="max-w-md">
				<DialogHeader>
					<DialogTitle>{t("Keep receipts")}</DialogTitle>
					<DialogDescription>
						{t(
							"Save a copy of the mail and its receipt to your Drive, under Money Watch/Receipts, so it keeps working after the mail is gone.",
						)}
					</DialogDescription>
				</DialogHeader>
				{!driveOn ? (
					<p className="text-sm text-neutral-600" data-finance-receipts-drive-off>
						{t("Drive is turned off, so no copies are saved. Ask an admin to turn Drive on under Admin → Modules.")}
					</p>
				) : settings ? (
					<>
						{loadFailed && (
							<p className="text-sm text-red-600" role="alert" data-finance-receipts-load-failed>
								{t("Could not load the Keep receipts setting.")}{" "}
								<button type="button" className="underline" onClick={() => setVersion((current) => current + 1)}>
									{t("Retry")}
								</button>
							</p>
						)}
						<SettingRow
							label={t("Keep receipts")}
							description={t("Counts toward your Drive storage quota.")}
							control={<Switch checked={settings.enabled} onCheckedChange={toggle} aria-label={t("Keep receipts")} />}
						/>
						<div className="space-y-2 border-t border-neutral-200 pt-4">
							<p className="text-sm text-neutral-600">
								{t("Save receipts for existing payments and subscriptions while the mail still exists.")}
							</p>
							{running ? (
								<p className="text-sm text-neutral-600" role="status">
									{t("{filed} filed so far, {skipped} skipped", {
										filed: settings.backfill!.filed,
										skipped: settings.backfill!.skipped,
									})}
								</p>
							) : (
								<Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => void startBackfill()}>
									{t("Save receipts for existing payments")}
								</Button>
							)}
							{settings.backfill?.status === "done" && (
								<p className="text-sm text-neutral-600" role="status">
									{t("{filed} filed so far, {skipped} skipped", {
										filed: settings.backfill.filed,
										skipped: settings.backfill.skipped,
									})}
								</p>
							)}
							{settings.backfill?.status === "done" && settings.backfill.pending > 0 && (
								<p className="text-sm text-neutral-600" role="status">
									{t(
										"{pending} could not be saved right now (for example, Drive storage is full). Choose “Save receipts for existing payments” again to retry them.",
										{
											pending: settings.backfill.pending,
										},
									)}
								</p>
							)}
						</div>
					</>
				) : loadFailed ? (
					<p className="text-sm text-red-600" role="alert" data-finance-receipts-load-failed>
						{t("Could not load the Keep receipts setting.")}{" "}
						<button type="button" className="underline" onClick={() => setVersion((current) => current + 1)}>
							{t("Retry")}
						</button>
					</p>
				) : (
					<p className="text-sm text-neutral-600">{t("Loading…")}</p>
				)}
			</DialogContent>
		</Dialog>
	);
}
