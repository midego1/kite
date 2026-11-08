"use client";

import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Info } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useCurrentUser } from "@/hooks/use-current-user";
import { useT } from "@/lib/i18n/use-t";
import { visibleMailboxTourSteps } from "./mailbox-tour-steps";
import {
	fetchMailboxTourDismissed,
	MAILBOX_TOUR_QUERY,
	MAILBOX_TOUR_REPLAY_EVENT,
	requestMailboxTourReplay,
	saveMailboxTourDismissed,
} from "./mailbox-tour-query";

/** The account menu's "Mailbox tour" entry, for everyone other than the owner (`isPrimaryAdmin`). */
export function MailboxTourMenuAction({ onNavigate }: { onNavigate: () => void }) {
	const t = useT();
	const user = useCurrentUser();
	if (!user || user.isPrimaryAdmin) return null;
	return (
		<button
			type="button"
			onClick={() => {
				requestMailboxTourReplay();
				onNavigate();
			}}
			className="mt-1 flex w-full items-center gap-3 rounded-xl px-3 py-2 text-start text-sm font-medium text-neutral-700 hover:bg-[#f2f6fc]"
		>
			<Info size={18} className="text-neutral-600" />
			{t("Mailbox tour")}
		</button>
	);
}

/**
 * A first-login tour of the mailbox for everyone other than the owner (`isPrimaryAdmin`), who gets the "Get
 * started" checklist instead. Opens on its own once, the first time this account's layout answers `dismissed:
 * false`, and can be replayed from the account menu (`requestMailboxTourReplay`). Finishing or skipping saves
 * `mailboxTourDismissed` in the account's layout preferences, so it does not open on its own again; replaying
 * leaves that choice as it was.
 */
export function MailboxTourDialog({ assistantAvailable }: { assistantAvailable: boolean | null }) {
	const t = useT();
	const user = useCurrentUser();
	const eligible = !!user && !user.isPrimaryAdmin;
	const steps = visibleMailboxTourSteps(assistantAvailable);
	const queryClient = useQueryClient();
	const queryKey = [...MAILBOX_TOUR_QUERY, user?.id];
	const [open, setOpen] = useState(false);
	const [step, setStep] = useState(0);
	// Which account's tour this already opened on its own, so switching to a different undismissed account
	// (without this component unmounting) still gets its own auto-open instead of being blocked by the last one.
	const autoOpenedFor = useRef<string | null>(null);

	const { data: dismissed } = useQuery({
		queryKey,
		queryFn: fetchMailboxTourDismissed,
		enabled: eligible,
		staleTime: 30_000,
		retry: false,
	});

	useEffect(() => {
		if (!eligible || dismissed !== false || autoOpenedFor.current === user.id) return;
		autoOpenedFor.current = user.id;
		setStep(0);
		setOpen(true);
	}, [eligible, dismissed, user?.id]);

	useEffect(() => {
		if (!eligible) return;
		const onReplay = () => {
			setStep(0);
			setOpen(true);
		};
		window.addEventListener(MAILBOX_TOUR_REPLAY_EVENT, onReplay);
		return () => window.removeEventListener(MAILBOX_TOUR_REPLAY_EVENT, onReplay);
	}, [eligible]);

	if (!eligible) return null;

	function finish() {
		setOpen(false);
		if (dismissed === true) return;
		queryClient.setQueryData(queryKey, true);
		void saveMailboxTourDismissed(true).catch(() => queryClient.invalidateQueries({ queryKey }));
	}

	// The assistant can turn off between steps (availability refreshes on focus): never read past the end.
	const clampedStep = Math.min(step, steps.length - 1);
	const last = clampedStep === steps.length - 1;
	const current = steps[clampedStep];
	const Icon = current.icon;

	return (
		<Dialog open={open} onOpenChange={(next) => (next ? setOpen(true) : finish())}>
			<DialogContent data-testid="mailbox-tour" className="w-[min(440px,calc(100vw-32px))]">
				<DialogHeader>
					<div className="flex items-center gap-3">
						<span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-blue-50 text-blue-600 dark:bg-blue-950 dark:text-blue-300">
							<Icon className="h-5 w-5" aria-hidden="true" />
						</span>
						<DialogTitle>{t(current.title)}</DialogTitle>
					</div>
					<DialogDescription>{t(current.description)}</DialogDescription>
				</DialogHeader>
				<div className="flex items-center justify-between gap-3 pt-2">
					<div className="flex items-center gap-1.5" role="presentation">
						{steps.map((tourStep, index) => (
							<span
								key={tourStep.id}
								aria-hidden="true"
								className={`h-1.5 w-5 rounded-full transition-colors ${index === clampedStep ? "bg-blue-600" : "bg-neutral-200"}`}
							/>
						))}
						<span className="sr-only">
							{t("Step {step} of {total}", { step: clampedStep + 1, total: steps.length })}
						</span>
					</div>
					<div className="flex items-center gap-2">
						{!last && (
							<Button type="button" variant="ghost" size="sm" onClick={finish}>
								{t("Skip tour")}
							</Button>
						)}
						{step > 0 && (
							<Button type="button" variant="outline" size="sm" onClick={() => setStep((value) => value - 1)}>
								{t("Back")}
							</Button>
						)}
						{last ? (
							<Button type="button" size="sm" onClick={finish}>
								{t("Done")}
							</Button>
						) : (
							<Button type="button" size="sm" onClick={() => setStep((value) => value + 1)}>
								{t("Next")}
							</Button>
						)}
					</div>
				</div>
			</DialogContent>
		</Dialog>
	);
}
