"use client";

import { useState } from "react";
import Link from "next/link";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Circle, ListChecks } from "lucide-react";
import { Card, CardContent, CardTitleRow } from "@/components/ui/card";
import { useCurrentUser } from "@/hooks/use-current-user";
import { SOURCE_CODE_URL } from "@/lib/source-code";
import type { OnboardingChecklistItem } from "@/lib/admin/onboarding-checklist-types";
import {
	fetchOnboardingChecklist,
	ONBOARDING_CHECKLIST_QUERY,
	saveOnboardingChecklistDismissed,
} from "./admin-onboarding-checklist-query";

function docUrl(path: string): string {
	return `${SOURCE_CODE_URL}/blob/main/docs/${path}`;
}

function ChecklistRow({ item }: { item: OnboardingChecklistItem }) {
	return (
		<div className="flex items-start gap-3 py-2.5" data-testid={`onboarding-item-${item.id}`} data-done={item.done}>
			{item.done ? (
				<CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-green-600" aria-hidden="true" />
			) : (
				<Circle className="mt-0.5 h-4 w-4 shrink-0 text-neutral-300" aria-hidden="true" />
			)}
			<div className="min-w-0 flex-1 space-y-1">
				<p className="text-sm font-medium text-neutral-900">
					<span className="sr-only">{item.done ? "Done: " : "Not done: "}</span>
					{item.title}
				</p>
				<p className="text-sm text-neutral-500">{item.detail}</p>
				<p className="flex flex-wrap items-center gap-3 text-sm">
					<Link href={item.href} className="font-medium underline underline-offset-2 hover:opacity-80">
						{item.hrefLabel}
					</Link>
					{item.docHref && (
						<a
							href={docUrl(item.docHref)}
							target="_blank"
							rel="noreferrer"
							className="text-neutral-500 underline underline-offset-2 hover:opacity-80"
						>
							{item.docLabel}
						</a>
					)}
				</p>
			</div>
		</div>
	);
}

/** A short line in place of the card: an error, or a link to bring a dismissed checklist back. */
function ChecklistLine({
	testId,
	tone = "neutral",
	message,
	action,
}: {
	testId: string;
	tone?: "neutral" | "error";
	message: string;
	action?: { label: string; onClick: () => void; disabled?: boolean };
}) {
	return (
		<p
			role={tone === "error" ? "alert" : undefined}
			data-testid={testId}
			className={`flex flex-wrap items-center gap-3 text-sm ${tone === "error" ? "text-red-600 dark:text-red-400" : "text-neutral-500"}`}
		>
			{message}
			{action && (
				<button
					type="button"
					onClick={action.onClick}
					disabled={action.disabled}
					className="font-medium text-neutral-900 underline underline-offset-2 hover:opacity-80 disabled:opacity-50"
				>
					{action.label}
				</button>
			)}
		</p>
	);
}

/**
 * The dismissible "Get started" checklist, shared by the admin overview and onboarding: every item's done state
 * comes from `GET /api/admin/onboarding-checklist`, read fresh on every mount so it flips on its own as the owner
 * sets things up elsewhere. Owner only (`isPrimaryAdmin`), shown only once the first mailbox exists; dismissing is
 * this owner's choice alone, and a short line in the card's place brings it back.
 */
export function OnboardingChecklistCard() {
	const user = useCurrentUser();
	const primary = user?.isPrimaryAdmin === true;
	const queryClient = useQueryClient();
	const [pending, setPending] = useState(false);
	const [actionError, setActionError] = useState("");
	const { data, isError } = useQuery({
		queryKey: ONBOARDING_CHECKLIST_QUERY,
		queryFn: fetchOnboardingChecklist,
		enabled: primary,
		staleTime: 30_000,
		refetchOnMount: "always",
		retry: false,
	});

	if (!primary) return null;
	if (isError)
		return (
			<ChecklistLine testId="onboarding-checklist-error" tone="error" message="Could not load the setup checklist." />
		);
	// Nothing to show yet: loading, or (per the roadmap) before the first mailbox exists.
	if (!data || !data.items.find((item) => item.id === "mailbox")?.done) return null;

	async function setDismissed(dismissed: boolean) {
		setPending(true);
		setActionError("");
		try {
			await saveOnboardingChecklistDismissed(dismissed);
			await queryClient.invalidateQueries({ queryKey: ONBOARDING_CHECKLIST_QUERY });
		} catch (error) {
			setActionError(error instanceof Error ? error.message : "Could not save the checklist.");
		} finally {
			setPending(false);
		}
	}

	if (data.dismissed)
		return (
			<ChecklistLine
				testId="onboarding-checklist-restore"
				tone={actionError ? "error" : "neutral"}
				message={actionError || "Get started checklist dismissed."}
				action={{ label: "Show it again", onClick: () => void setDismissed(false), disabled: pending }}
			/>
		);

	const doneCount = data.items.filter((item) => item.done).length;

	return (
		<Card data-testid="onboarding-checklist">
			<CardTitleRow
				icon={ListChecks}
				title="Get started"
				description={`${doneCount} of ${data.items.length} done`}
				action={
					<button
						type="button"
						onClick={() => void setDismissed(true)}
						disabled={pending}
						className="text-sm font-medium text-neutral-600 underline underline-offset-2 hover:opacity-80 disabled:opacity-50"
					>
						Dismiss
					</button>
				}
			/>
			{actionError && (
				<p role="alert" className="mt-2 text-sm text-red-600 dark:text-red-400">
					{actionError}
				</p>
			)}
			<CardContent className="divide-y divide-neutral-100 pt-4">
				{data.items.map((item) => (
					<ChecklistRow key={item.id} item={item} />
				))}
			</CardContent>
		</Card>
	);
}
