"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, CircleX, Database, ShieldCheck } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { getMigrationStatus, pendingMigrationsTitle } from "./admin-update-card-utils";
import type { MigrationStatusResponse } from "./admin-update-card-types";
import { applyMigrations, useMigrationApply, type MigrationApplyState } from "./migration-apply";
import { MigrationApplyButton, MigrationApplyProgress } from "./migration-progress";
import { migrationApplierText, shouldShowMigrationsBanner } from "./migrations-banner-utils";
import { useMigrationsNotice } from "./use-migrations-notice";
import { BUILD_VERSION_LABEL } from "@/lib/build-version";

const PENDING_PANEL_CLASS = "rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900";
const PENDING_BODY =
	"Kite was updated, but these changes to the database have not been applied yet. Until they are, new email may not appear and some pages may fail.";

function PendingMigrations({
	names,
	progress,
	onMigrate,
}: {
	names: string[];
	progress: MigrationApplyState;
	onMigrate: () => void;
}) {
	const isMigrating = progress.applying;
	return (
		<section aria-label="Pending database updates" className={PENDING_PANEL_CLASS}>
			<div className="flex items-start gap-3">
				<Database
					className={`mt-0.5 h-5 w-5 shrink-0 text-amber-700 ${isMigrating ? "animate-pulse" : ""}`}
					aria-hidden="true"
				/>
				<div className="min-w-0 flex-1">
					<p className="font-medium">{pendingMigrationsTitle(names.length)}</p>
					<p className="mt-1">{PENDING_BODY}</p>
					<ol aria-label="Pending migrations" className="mt-3 space-y-1 font-mono text-xs text-amber-800">
						{names.map((name) => (
							<li key={name} className="break-all">
								{name}
							</li>
						))}
					</ol>
					<p className="mt-3 flex items-start gap-2">
						<ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-amber-700" aria-hidden="true" />
						<span>
							Before applying them, Kite saves a safety backup of the database when there is data to save. It is listed
							on the{" "}
							<Link href="/backups" className="underline underline-offset-2 hover:text-amber-950">
								Backups
							</Link>{" "}
							page.
						</span>
					</p>
				</div>
			</div>
			{isMigrating && progress.source === "admin" && <MigrationApplyProgress progress={progress} />}
			<div className="mt-4 flex justify-end">
				<MigrationApplyButton
					busy={isMigrating}
					idleLabel="Update database"
					onClick={onMigrate}
					size="lg"
					showIcon
					className="w-full sm:w-auto"
				/>
			</div>
		</section>
	);
}

function UpToDate({ summary }: { summary: string | null }) {
	return (
		<div role="status" className="flex items-start gap-3 rounded-lg border border-neutral-200 px-4 py-4">
			<CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-green-600" aria-hidden="true" />
			<div className="text-sm text-neutral-700">
				{summary && <p className="font-medium">Database updated</p>}
				<p>The database schema is up to date.</p>
				{summary && <p className="mt-1 text-neutral-500">{summary}</p>}
			</div>
		</div>
	);
}

/** What this card says about the run: its own result only, so the mailbox notice never repeats it. */
function adminOutcome(progress: MigrationApplyState, statusError: string) {
	const owns = progress.source === "admin";
	return { summary: owns ? progress.summary : null, error: (owns ? progress.error : null) || statusError };
}

export function AdminUpdateCard() {
	const queryClient = useQueryClient();
	const [migrationError, setMigrationError] = useState("");
	const [migrationStatus, setMigrationStatus] = useState<MigrationStatusResponse>();
	const [isCheckingMigrations, setIsCheckingMigrations] = useState(true);
	const progress = useMigrationApply();

	useEffect(() => {
		let isActive = true;

		getMigrationStatus()
			.then((databaseStatus) => {
				if (isActive) setMigrationStatus(databaseStatus);
			})
			.catch((statusError) => {
				if (isActive) {
					setMigrationError(statusError instanceof Error ? statusError.message : "Could not check database migrations");
				}
			})
			.finally(() => {
				if (isActive) setIsCheckingMigrations(false);
			});

		return () => {
			isActive = false;
		};
	}, []);

	function handleMigrate() {
		setMigrationError("");
		// The run's own answer replaces the list before the card re-renders, so the pending panel never flashes back.
		void applyMigrations(migrationStatus?.pending ?? [], "admin", (result) =>
			setMigrationStatus({
				ready: result.ready ?? !result.pending?.length,
				pending: result.pending ?? [],
				unknown: result.unknown ?? [],
				applied: result.applied,
				backupId: result.backupId,
			}),
		);
	}

	// A run can end here or in the mailbox notice (it is one shared run); either way the list below is stale.
	useEffect(() => {
		if (!progress.summary && !progress.error && !progress.refreshTick) return;
		getMigrationStatus()
			.then(setMigrationStatus)
			.catch(() => undefined);
		// The mailbox notice reads its own status; it must not keep warning after this.
		void queryClient.invalidateQueries({ queryKey: ["pending-migrations"] });
	}, [progress.summary, progress.error, progress.refreshTick, queryClient]);

	const outcome = adminOutcome(progress, migrationError);
	const pending = migrationStatus?.pending ?? [];
	const unknown = migrationStatus?.unknown.length ?? 0;

	return (
		<Card>
			<CardHeader className="flex-row items-center gap-4 space-y-0">
				<div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-neutral-200 bg-[#f6f8fc] text-neutral-600">
					<Database className="h-5 w-5" />
				</div>
				<div>
					<CardTitle className="text-base">Database</CardTitle>
					<p className="mt-1 text-sm text-neutral-500">
						Kite v{BUILD_VERSION_LABEL}. Keep the database schema in step with the deployed version.
					</p>
				</div>
			</CardHeader>
			<CardContent className="space-y-5 pt-4">
				{isCheckingMigrations && (
					<div className="flex items-center gap-3 rounded-lg border border-neutral-200 px-4 py-4">
						<Skeleton className="h-4 w-4 rounded-full" />
						<Skeleton className="h-4 w-44" />
					</div>
				)}

				{!isCheckingMigrations && migrationStatus && !pending.length && !unknown && (
					<UpToDate summary={outcome.summary} />
				)}

				{!isCheckingMigrations && !!pending.length && !unknown && (
					<PendingMigrations names={pending} progress={progress} onMigrate={handleMigrate} />
				)}

				{!isCheckingMigrations && !!unknown && (
					<div className="flex items-center gap-3 rounded-lg border border-neutral-200 px-4 py-4 text-sm text-red-600">
						<CircleX className="h-4 w-4 shrink-0" />
						Deploy the matching Kite release before changing this database.
					</div>
				)}

				{outcome.error && (
					<p role="alert" className="text-sm text-red-600 dark:text-red-400">
						{outcome.error}
					</p>
				)}
			</CardContent>
		</Card>
	);
}

/** For admins other than the primary admin: what is waiting, and the one account that can apply it. */
export function AdminPendingMigrationsNotice() {
	const { data } = useMigrationsNotice();
	if (!data || !shouldShowMigrationsBanner(data)) return null;

	return (
		<section aria-label="Pending database updates" className={PENDING_PANEL_CLASS}>
			<div className="flex items-start gap-3">
				<Database className="mt-0.5 h-5 w-5 shrink-0 text-amber-700" aria-hidden="true" />
				<div className="min-w-0 flex-1">
					<p className="font-medium">{pendingMigrationsTitle(data.pending)}</p>
					<p className="mt-1">{PENDING_BODY}</p>
					<p className="mt-2 font-medium">{migrationApplierText(data.appliedBy)}</p>
				</div>
			</div>
		</section>
	);
}
