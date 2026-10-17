"use client";

import Link from "next/link";
import { CheckCircle2, Database } from "lucide-react";
import { Button } from "@/components/ui/button";
import { migrationsBannerContent, shouldShowMigrationsBanner } from "./migrations-banner-utils";
import { useMigrationsCardVisible, useMigrationsNotice } from "./use-migrations-notice";

function AppliedNotice({ summary, className }: { summary: string; className: string }) {
	return (
		<section
			aria-label="Database updates"
			className={`flex items-start gap-3 rounded-2xl bg-green-50 px-4 py-3 text-sm text-green-700 ${className}`}
		>
			<CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
			<div className="min-w-0 flex-1">
				<p className="font-medium">Database updated</p>
				<p className="mt-1">{summary}</p>
			</div>
		</section>
	);
}

/**
 * The full notice, shown in the empty reading pane: a deployed version runs before
 * its migrations are applied, and until then new mail cannot be stored.
 */
export function MigrationsNoticeCard() {
	const { user, isPrimaryAdmin, data, applying, summary, error, apply } = useMigrationsNotice();
	if (!user) return null;
	if (!data || !shouldShowMigrationsBanner(data)) {
		// Everything applied: the result of the run stays until the page is left.
		return summary ? <AppliedNotice summary={summary} className="w-full max-w-md text-left" /> : null;
	}
	const content = migrationsBannerContent(data.pending);

	return (
		<section
			aria-label="Database updates"
			className="w-full max-w-md rounded-2xl border border-amber-200 bg-amber-50 p-5 text-left text-sm text-amber-900"
		>
			<div className="flex items-start gap-3">
				<Database
					className={`mt-0.5 h-5 w-5 shrink-0 text-amber-700 ${applying ? "animate-pulse" : ""}`}
					aria-hidden="true"
				/>
				<div className="min-w-0 flex-1">
					<p className="font-medium">{content.title}</p>
					<p className="mt-1">{content.body}</p>
					{data.names?.length ? <p className="mt-2 break-all text-xs text-amber-800">{data.names.join(", ")}</p> : null}
					{summary && <p className="mt-2">{summary}</p>}
					{error && (
						<p role="alert" className="mt-2 text-red-700">
							{error}
						</p>
					)}
					{!isPrimaryAdmin && <p className="mt-2">Ask an administrator to apply them.</p>}
				</div>
			</div>
			{isPrimaryAdmin || user.role === "admin" ? (
				<div className="mt-4 flex items-center justify-end gap-3">
					<Link href="/admin" className="text-xs text-amber-800 underline underline-offset-2 hover:text-amber-900">
						Admin overview
					</Link>
					{isPrimaryAdmin && (
						<Button type="button" size="sm" disabled={applying} onClick={apply}>
							{applying ? "Applying…" : "Apply now"}
						</Button>
					)}
				</div>
			) : null}
		</section>
	);
}

/** One line above the mailbox, for whenever the empty reading pane (and its card) is not on screen. */
export function MigrationsBanner() {
	const { user, isPrimaryAdmin, data, applying, summary, error, apply } = useMigrationsNotice();
	const cardVisible = useMigrationsCardVisible();
	if (!user || cardVisible) return null;
	if (!data || !shouldShowMigrationsBanner(data)) {
		return summary ? <AppliedNotice summary={summary} className="mx-2 mb-2 shrink-0 md:ml-0 md:mr-4" /> : null;
	}
	const content = migrationsBannerContent(data.pending);

	return (
		<section
			aria-label="Database updates"
			title={data.names?.join(", ")}
			className="mx-2 mb-2 flex shrink-0 items-center gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-1.5 text-xs text-amber-900 md:ml-0 md:mr-4"
		>
			<Database
				className={`h-3.5 w-3.5 shrink-0 text-amber-700 ${applying ? "animate-pulse" : ""}`}
				aria-hidden="true"
			/>
			<p className="min-w-0 flex-1 truncate">
				<span className="font-medium">{content.title}.</span>{" "}
				{error ? (
					<span role="alert" className="text-red-700">
						{error}
					</span>
				) : isPrimaryAdmin ? (
					content.body
				) : (
					"Ask an administrator to apply them."
				)}
			</p>
			{isPrimaryAdmin ? (
				<Button type="button" size="sm" className="h-6 px-2 text-xs" disabled={applying} onClick={apply}>
					{applying ? "Applying…" : "Apply now"}
				</Button>
			) : user.role === "admin" ? (
				<Link href="/admin" className="shrink-0 underline underline-offset-2">
					Admin overview
				</Link>
			) : null}
		</section>
	);
}
