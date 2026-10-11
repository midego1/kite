"use client";

import { useEffect, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { CalendarDays, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { authFetch } from "@/lib/auth/client";
import type { InviteOption } from "@/lib/agent/auto-read/invite-actions-utils";
import { getUserTimeZone } from "@/lib/time/utils";
import { activityUrl } from "./agent-activity-utils";
import type { ActivityAction, ActivityResponse } from "./agent-activity-types";
import type { CardSuggestion } from "./suggestion-card-types";
import { answerInvite } from "./suggestion-invite-actions";
import {
	answeredText,
	formatInviteRange,
	inviteAnswer,
	inviteButtons,
	invitePayload,
	inviteWarnings,
	type InviteAnswer,
} from "./suggestion-invite-utils";

type BlockProps = { suggestion: CardSuggestion; onChanged: () => void; menu: ReactNode; why: ReactNode };

function useInviteAnswer(onChanged: () => void) {
	const router = useRouter();
	const [busy, setBusy] = useState<InviteOption | null>(null);
	const [error, setError] = useState<string | null>(null);

	async function answer(suggestion: CardSuggestion, option: InviteOption) {
		setBusy(option);
		setError(null);
		try {
			const { done, url } = await answerInvite(suggestion, option);
			if (url) router.push(url);
			else if (done) onChanged();
		} catch (caught) {
			setError(caught instanceof Error ? caught.message : String(caught));
		} finally {
			setBusy(null);
		}
	}
	return { busy, error, answer };
}

function Warnings({ warnings }: { warnings: string[] }) {
	if (warnings.length === 0) return null;
	return (
		<ul data-invite-warnings className="mt-2 space-y-1">
			{warnings.map((warning) => (
				<li key={warning} className="flex items-start gap-1.5 text-xs text-amber-700">
					<TriangleAlert aria-hidden className="mt-0.5 h-3.5 w-3.5 shrink-0" />
					{warning}
				</li>
			))}
		</ul>
	);
}

function Conflicts({
	payload,
	timeZone,
}: {
	payload: NonNullable<ReturnType<typeof invitePayload>>;
	timeZone: string;
}) {
	if (payload.conflicts.length === 0)
		return (
			<p data-invite-conflicts="none" className="mt-2 text-neutral-600">
				No conflicts
			</p>
		);
	return (
		<div data-invite-conflicts="list" className="mt-2">
			<p className="text-xs font-medium text-amber-700">Conflicts with</p>
			<ul className="mt-1 space-y-0.5 text-neutral-700">
				{payload.conflicts.map((conflict) => (
					<li key={`${conflict.eventId}-${conflict.start}`} data-invite-conflict>
						<span className="font-medium">{conflict.title}</span>
						<span className="text-neutral-600"> · {formatInviteRange(conflict.start, conflict.end, timeZone)}</span>
					</li>
				))}
			</ul>
		</div>
	);
}

function ErrorLine({ error }: { error: string | null }) {
	return error ? (
		<p role="alert" className="mt-2 text-xs text-red-600">
			{error}
		</p>
	) : null;
}

/** The open calendar invitation: when, who, conflicts, and the answers. */
export function InviteBlock({ suggestion, onChanged, menu, why }: BlockProps) {
	const { busy, error, answer } = useInviteAnswer(onChanged);
	const payload = invitePayload(suggestion);
	if (!payload) return null;
	const timeZone = getUserTimeZone();
	return (
		<div data-suggestion-block="calendar_invite" data-suggestion-id={suggestion.id} className="mt-3 first:mt-0">
			<div className="flex items-start justify-between gap-2">
				<p className="flex items-center gap-2 font-medium text-neutral-900">
					<CalendarDays aria-hidden className="h-4 w-4 shrink-0 text-blue-700" />
					{suggestion.title}
				</p>
				{menu}
			</div>
			<p data-invite-when className="mt-1 text-neutral-800">
				{formatInviteRange(payload.start, payload.end, timeZone)}
				{payload.repeats && <span className="ml-1 text-xs text-neutral-600">(repeats)</span>}
			</p>
			{payload.organizer && <p className="text-xs text-neutral-600">Organizer: {payload.organizer}</p>}
			{payload.method !== "CANCEL" && <Conflicts payload={payload} timeZone={timeZone} />}
			<Warnings warnings={inviteWarnings(payload)} />
			<div className="mt-3 flex flex-wrap gap-2">
				{inviteButtons(payload).map((button) => (
					<Button
						key={button.option}
						size="sm"
						variant={button.primary ? "default" : "outline"}
						disabled={busy !== null}
						onClick={() => void answer(suggestion, button.option)}
					>
						{busy === button.option ? "Working…" : button.label}
					</Button>
				))}
			</div>
			<ErrorLine error={error} />
			{why}
		</div>
	);
}

/** Reads the live reply of an answered invitation, refreshed whenever the suggestion list reloads. */
function useAnswer(suggestion: CardSuggestion): InviteAnswer | null {
	const [answer, setAnswer] = useState<InviteAnswer | null>(null);
	useEffect(() => {
		let cancelled = false;
		void authFetch(activityUrl(suggestion.mailboxId))
			.then(async (response) => (response.ok ? ((await response.json()) as ActivityResponse) : null))
			.then((data) => {
				if (cancelled || !data) return;
				setAnswer(inviteAnswer(suggestion.id, data.actions as ActivityAction[]));
			})
			.catch(() => undefined);
		return () => {
			cancelled = true;
		};
	}, [suggestion]);
	return answer;
}

/** An answered invitation: what stands now, and the one switch that still applies. */
export function AnsweredInviteBlock({ suggestion, onChanged }: Pick<BlockProps, "suggestion" | "onChanged">) {
	const { busy, error, answer } = useInviteAnswer(onChanged);
	const payload = invitePayload(suggestion);
	const state = useAnswer(suggestion);
	if (!payload || !state) return null;
	const switchTo: { option: InviteOption; label: string } | null =
		state.rsvp === "accepted"
			? { option: "decline_instead", label: "Send decline instead" }
			: state.rsvp === "declined"
				? { option: "accept_instead", label: "Accept instead" }
				: null;
	return (
		<div data-suggestion-block="calendar_answered" data-suggestion-id={suggestion.id} className="mt-3 first:mt-0">
			<p className="flex items-center gap-2 font-medium text-neutral-900">
				<CalendarDays aria-hidden className="h-4 w-4 shrink-0 text-blue-700" />
				{suggestion.title}
			</p>
			<p data-invite-answer className="mt-1 text-neutral-700">
				{answeredText(state, payload)}
			</p>
			{switchTo && (
				<div className="mt-2 flex flex-wrap gap-2">
					<Button
						size="sm"
						variant="outline"
						disabled={busy !== null}
						onClick={() => void answer(suggestion, switchTo.option)}
					>
						{busy ? "Working…" : switchTo.label}
					</Button>
				</div>
			)}
			<ErrorLine error={error} />
		</div>
	);
}
