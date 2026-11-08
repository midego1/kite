"use client";

import { useEffect, useState } from "react";
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

async function fetchJson<T>(path: string, init?: RequestInit): Promise<T | null> {
	const response = await authFetch(path, init);
	return response.ok ? ((await response.json().catch(() => null)) as T | null) : null;
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
	const running = settings?.backfill?.status === "running";

	useEffect(() => {
		if (!open || !driveOn) return;
		let live = true;
		void fetchJson<ReceiptSettings>("/api/finance/receipts").then((data) => {
			if (live) setSettings(data);
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
		setSettings((current) => (current ? { ...current, enabled: next } : current));
		const saved = await fetchJson<{ enabled: boolean }>("/api/finance/receipts", {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ enabled: next }),
		});
		if (!saved) {
			toast.error(t("Could not save the setting"));
			setSettings((current) => (current ? { ...current, enabled: !next } : current));
		}
	}

	async function startBackfill() {
		setBusy(true);
		const result = await fetchJson<{ backfill: BackfillStatus }>("/api/finance/receipts/backfill", {
			method: "POST",
		});
		setBusy(false);
		if (!result) {
			toast.error(t("Could not start"));
			return;
		}
		setSettings((current) => (current ? { ...current, backfill: result.backfill } : current));
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
										"{pending} could not be saved right now (for example, Drive storage is full) and will be tried again automatically",
										{
											pending: settings.backfill.pending,
										},
									)}
								</p>
							)}
						</div>
					</>
				) : (
					<p className="text-sm text-neutral-600">{t("Loading…")}</p>
				)}
			</DialogContent>
		</Dialog>
	);
}
