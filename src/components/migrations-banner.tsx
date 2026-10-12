"use client";

import Link from "next/link";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { CheckCircle2, Database } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useCurrentUser } from "@/hooks/use-current-user";
import type { MigrationApplyResponse, PendingMigrationsResponse } from "./migrations-banner-types";
import {
	PENDING_MIGRATIONS_REFRESH_MS,
	migrationApplySummary,
	migrationsBannerContent,
	parsePendingMigrations,
	shouldShowMigrationsBanner,
} from "./migrations-banner-utils";

async function fetchPendingMigrations(): Promise<PendingMigrationsResponse> {
	const response = await fetch("/api/migrations/pending", { cache: "no-store" });
	if (!response.ok) throw new Error(`Pending migrations request failed (${response.status})`);
	return parsePendingMigrations(await response.json());
}

/**
 * A deployed version runs before an admin applies its migrations, and until
 * they are applied new mail cannot be stored. The banner explains that to
 * everyone and lets the primary admin apply them from the mailbox.
 */
export function MigrationsBanner() {
	const user = useCurrentUser();
	const isPrimaryAdmin = user?.role === "admin" && user.isPrimaryAdmin;
	const [applying, setApplying] = useState(false);
	const [summary, setSummary] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const { data, refetch } = useQuery({
		queryKey: ["pending-migrations"],
		queryFn: fetchPendingMigrations,
		enabled: Boolean(user),
		refetchInterval: PENDING_MIGRATIONS_REFRESH_MS,
		// The app-wide defaults disable refetch on mount; this must be current whenever the mailbox is shown.
		refetchOnMount: "always",
		refetchOnWindowFocus: false,
		retry: false,
	});

	if (!user) return null;
	if (!data || !shouldShowMigrationsBanner(data)) {
		// Everything applied: the result of the run stays until the page is left.
		if (!summary) return null;
		return (
			<section
				aria-label="Database updates"
				className="mx-2 mb-2 flex shrink-0 items-start gap-3 rounded-2xl bg-green-50 px-4 py-3 text-sm text-green-700 md:ml-0 md:mr-4"
			>
				<CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
				<div className="min-w-0 flex-1">
					<p className="font-medium">Database updated</p>
					<p className="mt-1">{summary}</p>
				</div>
			</section>
		);
	}
	const content = migrationsBannerContent(data.pending);

	async function handleApply() {
		setApplying(true);
		setError(null);
		try {
			const response = await fetch("/api/admin/migrations", { method: "POST" });
			const result = (await response.json()) as MigrationApplyResponse;
			if (!response.ok) throw new Error(result.error ?? "Could not apply the database updates");
			setSummary(migrationApplySummary(result));
			// The next status answer hides the banner; a failure keeps it with the names.
			await refetch();
		} catch (failure) {
			setError(failure instanceof Error ? failure.message : "Could not apply the database updates");
		} finally {
			setApplying(false);
		}
	}

	return (
		<section
			aria-label="Database updates"
			className="mx-2 mb-2 flex shrink-0 items-start gap-3 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900 md:ml-0 md:mr-4"
		>
			<Database
				className={`mt-0.5 h-4 w-4 shrink-0 text-amber-700 ${applying ? "animate-pulse" : ""}`}
				aria-hidden="true"
			/>
			<div className="min-w-0 flex-1">
				<p className="font-medium">{content.title}</p>
				<p className="mt-1">{content.body}</p>
				{data.names?.length ? <p className="mt-1 text-xs text-amber-800">{data.names.join(", ")}</p> : null}
				{summary && <p className="mt-1">{summary}</p>}
				{error && <p className="mt-1 text-red-700">{error}</p>}
				{!isPrimaryAdmin && <p className="mt-1">Ask an administrator to apply them.</p>}
			</div>
			{isPrimaryAdmin ? (
				<div className="flex shrink-0 flex-col items-end gap-2">
					<Button type="button" size="sm" disabled={applying} onClick={handleApply}>
						{applying ? "Applying…" : "Apply now"}
					</Button>
					<Link href="/admin" className="text-xs text-amber-800 underline underline-offset-2 hover:text-amber-900">
						Admin overview
					</Link>
				</div>
			) : user.role === "admin" ? (
				<Link
					href="/admin"
					className="shrink-0 text-xs text-amber-800 underline underline-offset-2 hover:text-amber-900"
				>
					Admin overview
				</Link>
			) : null}
		</section>
	);
}
