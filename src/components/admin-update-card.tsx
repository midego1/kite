"use client";

import { useEffect, useState } from "react";
import { CheckCircle2, CircleX, Database } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { applyDatabaseMigrations, getMigrationStatus } from "./admin-update-card-utils";
import type { MigrationStatusResponse } from "./admin-update-card-types";
import { BUILD_VERSION_LABEL } from "@/lib/build-version";

export function AdminUpdateCard() {
	const [migrationError, setMigrationError] = useState("");
	const [migrationStatus, setMigrationStatus] = useState<MigrationStatusResponse>();
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
		setMigrationError("");
		setIsMigrating(true);
		try {
			setMigrationStatus(await applyDatabaseMigrations());
		} catch (migrationFailure) {
			setMigrationError(
				migrationFailure instanceof Error ? migrationFailure.message : "Could not apply database migrations",
			);
		} finally {
			setIsMigrating(false);
		}
	}

	const pending = migrationStatus?.pending.length ?? 0;
	const unknown = migrationStatus?.unknown.length ?? 0;

	return (
		<Card className="rounded-3xl border-0 bg-white p-6">
			<CardHeader className="flex-row items-center gap-4 space-y-0 py-0">
				<div className="flex h-10 w-10 items-center justify-center rounded-full bg-blue-100 text-blue-700">
					<Database className="h-5 w-5" />
				</div>
				<div>
					<CardTitle className="text-base">Database</CardTitle>
					<p className="mt-1 text-sm text-neutral-500">
						Kite v{BUILD_VERSION_LABEL}. Keep the database schema in step with the deployed version.
					</p>
				</div>
			</CardHeader>
			<CardContent className="space-y-5 pt-5">
				<div className="divide-y divide-neutral-100 overflow-hidden rounded-2xl border border-neutral-100">
					{isCheckingMigrations && (
						<div className="flex items-center gap-3 px-4 py-4">
							<Skeleton className="h-4 w-4 rounded-full" />
							<Skeleton className="h-4 w-44" />
						</div>
					)}

					{!isCheckingMigrations && migrationStatus && !pending && !unknown && (
						<div className="flex items-center gap-3 px-4 py-4">
							<CheckCircle2 className="h-4 w-4 shrink-0 text-green-600" />
							<p className="text-sm text-neutral-700">The database schema is up to date.</p>
						</div>
					)}

					{!isCheckingMigrations && !!pending && !unknown && (
						<div className="flex items-center gap-3 px-4 py-4">
							<Database className={`h-4 w-4 shrink-0 text-amber-600 ${isMigrating ? "animate-pulse" : ""}`} />
							<p className="text-sm text-neutral-700">
								{pending} database {pending === 1 ? "migration is" : "migrations are"} pending.
							</p>
							<button
								type="button"
								onClick={handleMigrate}
								disabled={isMigrating}
								className="ml-auto shrink-0 text-sm font-medium text-blue-700 hover:underline disabled:pointer-events-none disabled:opacity-50"
							>
								{isMigrating ? "Updating database..." : "Update database"}
							</button>
						</div>
					)}

					{!isCheckingMigrations && !!unknown && (
						<div className="flex items-center gap-3 px-4 py-4 text-sm text-red-600">
							<CircleX className="h-4 w-4 shrink-0" />
							Deploy the matching Kite release before changing this database.
						</div>
					)}
				</div>

				{migrationError && <p className="text-sm text-red-600">{migrationError}</p>}
			</CardContent>
		</Card>
	);
}
