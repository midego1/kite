"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowRightLeft, CheckCircle2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useConfirm } from "@/components/ui/confirm-dialog";
import type { LegacyImportMode, LegacyImportRun, LegacyImportStatus } from "@/lib/legacy-import/types";
import { describeLegacyImportPhase, legacyImportFraction, summarizeLegacyImport } from "./legacy-import-card-utils";
import { fetchLegacyImportStatus, runLegacyImportCopyStep, startLegacyImportCopy } from "./legacy-import-client";
import { LegacyImportRouting } from "./legacy-import-routing";

function CopyProgress({ run }: { run: LegacyImportRun }) {
	return (
		<div className="space-y-2">
			<p className="text-sm text-neutral-700">{describeLegacyImportPhase(run)}</p>
			<div className="h-1.5 overflow-hidden rounded-full bg-neutral-100">
				<div
					className="h-full rounded-full bg-blue-600 transition-[width]"
					style={{ width: `${Math.round(legacyImportFraction(run) * 100)}%` }}
				/>
			</div>
		</div>
	);
}

function CopyReport({ run }: { run: LegacyImportRun }) {
	return (
		<div className="space-y-2 text-sm text-neutral-700">
			<p className="flex items-start gap-2">
				<CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-green-600" />
				<span>
					{run.mode === "full" ? "Full copy" : "Catch-up"} finished. {summarizeLegacyImport(run)}
				</span>
			</p>
			{run.unreadableSecrets.length > 0 && (
				<p className="text-amber-700">
					These settings were encrypted with the old install&apos;s key and need to be entered again:{" "}
					{run.unreadableSecrets.join(", ")}.
				</p>
			)}
			{run.problems.length > 0 && (
				<ul className="list-disc space-y-1 pl-5 text-neutral-500">
					{run.problems.map((problem) => (
						<li key={problem}>{problem}</li>
					))}
				</ul>
			)}
		</div>
	);
}

function describeSource(status: LegacyImportStatus | null): string {
	const messages = status?.source?.messages;
	if (status?.source?.error) return `The old database cannot be read: ${status.source.error}`;
	if (typeof messages !== "number") return "The old database has no Kite data yet.";
	return `The old database holds ${messages.toLocaleString("en")} ${messages === 1 ? "message" : "messages"}.`;
}

function CopyStatus({
	run,
	copying,
	resumable,
	signedOut,
}: {
	run: LegacyImportRun | null;
	copying: boolean;
	resumable: boolean;
	signedOut: boolean;
}) {
	const finished = run?.phase === "done";
	return (
		<>
			{run && (copying || !finished) && <CopyProgress run={run} />}
			{run && finished && <CopyReport run={run} />}
			{run && !finished && !copying && !resumable && (
				<p className="text-sm text-neutral-500">
					The last copy stopped before it finished. Start it again: rows and files already copied are skipped.
				</p>
			)}
			{signedOut && (
				<p className="text-sm text-neutral-700">
					The accounts were replaced too.{" "}
					<Link href="/login" className="font-medium text-blue-700 hover:underline">
						Sign in again
					</Link>{" "}
					with your old account.
				</p>
			)}
		</>
	);
}

/** Shown only while LEGACY_DB and LEGACY_BUCKET are bound: copies the old install's data, then its mail routing. */
export function LegacyImportCard() {
	const [status, setStatus] = useState<LegacyImportStatus | null>(null);
	const [run, setRun] = useState<LegacyImportRun | null>(null);
	const [copying, setCopying] = useState(false);
	const [signedOut, setSignedOut] = useState(false);
	const [error, setError] = useState("");
	const [token, setToken] = useState<string | null>(null);
	const confirm = useConfirm();

	useEffect(() => {
		let active = true;
		fetchLegacyImportStatus()
			.then((next) => {
				if (!active) return;
				setStatus(next);
				setRun(next.run);
			})
			.catch((failure) => {
				if (active) setError(failure instanceof Error ? failure.message : "Could not read the old install");
			});
		return () => {
			active = false;
		};
	}, []);

	async function continueCopy(current: LegacyImportRun, activeToken: string) {
		setCopying(true);
		setError("");
		try {
			while (current.phase !== "done") {
				current = await runLegacyImportCopyStep(activeToken, current.step);
				setRun(current);
			}
			if (current.mode === "full") setSignedOut(true);
		} catch (failure) {
			setError(failure instanceof Error ? failure.message : "Copying failed");
		} finally {
			setCopying(false);
		}
	}

	async function startCopy(mode: LegacyImportMode) {
		if (
			mode === "full" &&
			!(await confirm({
				title: "Replace everything here with the old install's data?",
				description:
					"Accounts, mail, settings and files are copied from the old database. Anything already in this install is replaced, and you are signed out: sign in again with your old account when the copy is done.",
				confirmLabel: "Copy everything",
				typedConfirmation: "replace",
			}))
		)
			return;
		setError("");
		try {
			const started = await startLegacyImportCopy(mode);
			setToken(started.token);
			setRun(started.run);
			await continueCopy(started.run, started.token);
		} catch (failure) {
			setError(failure instanceof Error ? failure.message : "Could not start copying");
		}
	}

	if (!status?.available && !error) return null;
	const stopped = run && run.phase !== "done" && !copying;

	return (
		<Card className="mt-6 rounded-3xl border-0 bg-white p-6" data-testid="legacy-import-card">
			<CardHeader className="flex-row items-center gap-4 space-y-0 py-0">
				<div className="flex h-10 w-10 items-center justify-center rounded-full bg-blue-100 text-blue-700">
					<ArrowRightLeft className="h-5 w-5" />
				</div>
				<div>
					<CardTitle className="text-base">Move from the old install</CardTitle>
					<p className="mt-1 text-sm text-neutral-500">
						Copy accounts, mail and files from the database this install replaces, then deliver new mail here.
					</p>
				</div>
			</CardHeader>
			<CardContent className="space-y-4 pt-5">
				<div className="space-y-3 rounded-2xl border border-neutral-100 px-4 py-4">
					<p className="text-sm text-neutral-700">{describeSource(status)}</p>
					<CopyStatus run={run} copying={copying} resumable={!!token} signedOut={signedOut} />
					<div className="flex flex-wrap gap-2">
						<Button type="button" size="sm" disabled={copying} onClick={() => startCopy("full")}>
							Copy everything
						</Button>
						<Button type="button" variant="outline" size="sm" disabled={copying} onClick={() => startCopy("catch-up")}>
							Copy new mail
						</Button>
						{stopped && token && (
							<Button type="button" variant="outline" size="sm" onClick={() => continueCopy(run, token)}>
								Continue
							</Button>
						)}
					</div>
				</div>
				<LegacyImportRouting />
				{error && <p className="text-sm text-red-600">{error}</p>}
			</CardContent>
		</Card>
	);
}
