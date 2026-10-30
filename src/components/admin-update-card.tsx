"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, CircleX, Database, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { applyDatabaseMigrations, getMigrationStatus, pendingMigrationsTitle } from "./admin-update-card-utils";
import type { MigrationStatusResponse } from "./admin-update-card-types";
import { migrationApplySummary } from "./migrations-banner-utils";
import { BUILD_VERSION_LABEL } from "@/lib/build-version";

const PENDING_PANEL_CLASS = "rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900";
const PENDING_BODY =
	"Kite was updated, but these changes to the database have not been applied yet. Until they are, new email may not appear and some pages may fail.";

function PendingMigrations({
	names,
	isMigrating,
	onMigrate,
}: {
	names: string[];
	isMigrating: boolean;
	onMigrate: () => void;
}) {
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
			<div className="mt-4 flex justify-end">
				<Button type="button" size="lg" onClick={onMigrate} disabled={isMigrating} className="w-full sm:w-auto">
					<Database className="h-4 w-4" aria-hidden="true" />
					{isMigrating ? "Updating database…" : "Update database"}
				</Button>
			</div>
		</section>
	);
}

export function AdminUpdateCard() {
	const queryClient = useQueryClient();
	const [migrationError, setMigrationError] = useState("");
	const [migrationStatus, setMigrationStatus] = useState<MigrationStatusResponse>();
	const [appliedSummary, setAppliedSummary] = useState("");
	const [isCheckingMigrations, setIsCheckingMigrations] = useState(true);
	const [isMigrating, setIsMigrating] = useState(false);

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

	async function handleMigrate() {
		if (isMigrating) return;
		setMigrationError("");
		setAppliedSummary("");
		setIsMigrating(true);
		try {
			const result = await applyDatabaseMigrations();
			setMigrationStatus(result);
			setAppliedSummary(migrationApplySummary(result));
			// The mailbox notice reads its own status; it must not keep warning after this.
			await queryClient.invalidateQueries({ queryKey: ["pending-migrations"] });
		} catch (migrationFailure) {
			setMigrationError(
				migrationFailure instanceof Error ? migrationFailure.message : "Could not apply database migrations",
			);
		} finally {
			setIsMigrating(false);
		}
	}

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
					<div className="flex items-start gap-3 rounded-lg border border-neutral-200 px-4 py-4">
						<CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-green-600" />
						<div className="text-sm text-neutral-700">
							<p>The database schema is up to date.</p>
							{appliedSummary && <p className="mt-1 text-neutral-500">{appliedSummary}</p>}
						</div>
					</div>
				)}

				{!isCheckingMigrations && !!pending.length && !unknown && (
					<PendingMigrations names={pending} isMigrating={isMigrating} onMigrate={handleMigrate} />
				)}

				{!isCheckingMigrations && !!unknown && (
					<div className="flex items-center gap-3 rounded-lg border border-neutral-200 px-4 py-4 text-sm text-red-600">
						<CircleX className="h-4 w-4 shrink-0" />
						Deploy the matching Kite release before changing this database.
					</div>
				)}

				{migrationError && (
					<p role="alert" className="text-sm text-red-600">
						{migrationError}
					</p>
				)}
			</CardContent>
		</Card>
	);
}
