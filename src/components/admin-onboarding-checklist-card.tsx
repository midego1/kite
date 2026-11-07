"use client";

import { useState } from "react";
import Link from "next/link";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Circle, ListChecks } from "lucide-react";
import { Card, CardContent, CardTitleRow } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
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
				<p className="text-sm font-medium text-neutral-900">{item.title}</p>
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

/**
 * The dismissible "Get started" checklist, shared by the admin overview and onboarding: every item's done state
 * comes from `GET /api/admin/onboarding-checklist`, read fresh on every mount so it flips on its own as the owner
 * sets things up elsewhere. Owner only (`isPrimaryAdmin`); dismissing is this owner's choice alone.
 */
export function OnboardingChecklistCard() {
	const user = useCurrentUser();
	const primary = user?.isPrimaryAdmin === true;
	const queryClient = useQueryClient();
	const [dismissing, setDismissing] = useState(false);
	const { data, isLoading } = useQuery({
		queryKey: ONBOARDING_CHECKLIST_QUERY,
		queryFn: fetchOnboardingChecklist,
		enabled: primary,
		staleTime: 30_000,
		refetchOnMount: "always",
		retry: false,
	});

	if (!primary || data?.dismissed) return null;

	async function dismiss() {
		setDismissing(true);
		try {
			await saveOnboardingChecklistDismissed(true);
			await queryClient.invalidateQueries({ queryKey: ONBOARDING_CHECKLIST_QUERY });
		} catch {
			setDismissing(false);
		}
	}

	const items = data?.items ?? [];
	const doneCount = items.filter((item) => item.done).length;

	return (
		<Card data-testid="onboarding-checklist">
			<CardTitleRow
				icon={ListChecks}
				title="Get started"
				description={isLoading ? "Checking what is already set up…" : `${doneCount} of ${items.length} done`}
				action={
					<button
						type="button"
						onClick={() => void dismiss()}
						disabled={dismissing}
						className="text-sm font-medium text-neutral-600 underline underline-offset-2 hover:opacity-80 disabled:opacity-50"
					>
						Dismiss
					</button>
				}
			/>
			<CardContent className="divide-y divide-neutral-100 pt-4">
				{isLoading ? (
					<div className="space-y-3 py-1">
						<Skeleton className="h-10 w-full rounded-lg" />
						<Skeleton className="h-10 w-full rounded-lg" />
						<Skeleton className="h-10 w-full rounded-lg" />
					</div>
				) : (
					items.map((item) => <ChecklistRow key={item.id} item={item} />)
				)}
			</CardContent>
		</Card>
	);
}
