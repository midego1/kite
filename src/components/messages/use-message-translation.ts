"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useKeyChanged } from "@/hooks/use-synced-state";
import type { AiErrorBody } from "@/lib/agent/ai-error-utils";
import { detectMessageLanguage } from "@/lib/agent/translation/detect-language-utils";
import type { MessageTranslation, TranslationState } from "@/lib/agent/translation/translation-types";
import type { MessageTranslationController, MessageTranslationInput } from "./message-translation-types";
import {
	offersTranslation,
	readingLanguages,
	toggledLanguage,
	translationDisabledReason,
	translationSample,
	translationTarget,
	translationUrl,
} from "./message-translation-utils";
import { summaryError } from "./thread-summary-utils";
import { useTranslateNever, useTranslateTarget } from "./use-translate-target";

const FAILED = "Kite could not translate this. Try again.";

function browserLanguages(): string[] {
	if (typeof navigator === "undefined") return [];
	return readingLanguages(navigator.languages?.length ? navigator.languages : [navigator.language]);
}

/** A translation kept for this message, so opening it again costs nothing and counts toward no limit. */
async function keptTranslation(messageId: string, target: string): Promise<MessageTranslation | null> {
	const response = await fetch(translationUrl(messageId, target), { cache: "no-store" });
	return response.ok ? ((await response.json()) as TranslationState).translation : null;
}

type Requested = { target: string; quoted: boolean };

/**
 * One message's translation: whether to offer it, the chosen language, and the request. The reader always starts on
 * the original and swaps the shown body when asked; replying, forwarding and printing keep using the original.
 * Answers that arrive after the reader moved to another message are dropped.
 */
export function useMessageTranslation(input: MessageTranslationInput): MessageTranslationController {
	const { messageId, body, availability } = input;
	const [translation, setTranslation] = useState<MessageTranslation | null>(null);
	const [showing, setShowing] = useState(false);
	const [busy, setBusy] = useState<MessageTranslationController["busy"]>(null);
	const [error, setError] = useState<string | null>(null);
	const [failure, setFailure] = useState<AiErrorBody | null>(null);
	const [blocked, setBlocked] = useState(false);
	const [dismissed, setDismissed] = useState(false);
	const [retryable, setRetryable] = useState(true);
	const [justStopped, setJustStopped] = useState(false);
	const [chosen, setChosen] = useTranslateTarget();
	const [never, setNever] = useTranslateNever();
	const [reading] = useState(browserLanguages);
	const shownKey = useRef(messageId);
	const lastRequest = useRef<Requested | null>(null);
	if (useKeyChanged(messageId)) {
		setTranslation(null);
		setShowing(false);
		setBusy(null);
		setError(null);
		setFailure(null);
		setBlocked(false);
		setDismissed(false);
		setRetryable(true);
		setJustStopped(false);
	}
	useEffect(() => {
		shownKey.current = messageId;
	}, [messageId]);

	const subject = body?.subject;
	const textBody = body?.textBody;
	const htmlBody = body?.htmlBody;
	const present = body !== null;
	const detected = useMemo(
		() => (present ? detectMessageLanguage(translationSample({ subject, textBody, htmlBody })) : null),
		[present, subject, textBody, htmlBody],
	);
	const target = translationTarget(chosen, reading);

	const request = useCallback(
		async (requested: Requested) => {
			const current = () => shownKey.current === messageId;
			setBusy(requested.quoted ? "quoted" : "translate");
			setError(null);
			setFailure(null);
			setRetryable(true);
			lastRequest.current = requested;
			try {
				const kept = requested.quoted ? null : await keptTranslation(messageId, requested.target).catch(() => null);
				if (!current()) return;
				if (kept) {
					setTranslation(kept);
					setShowing(true);
					return;
				}
				const response = await fetch(translationUrl(messageId), {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(requested),
				});
				if (!response.ok) {
					const { message, failure: details } = await summaryError(response, FAILED);
					if (!current()) return;
					setFailure(details);
					setError(message);
					// Already in that language, or moved away: asking again says the same.
					setRetryable(response.status !== 409);
					// A cap holds until tomorrow; the rate limit is over in a moment, and Try again stays.
					if (response.status === 429 && details?.code !== "rate_limited") setBlocked(true);
					return;
				}
				const state = (await response.json()) as TranslationState;
				if (!current()) return;
				setTranslation(state.translation);
				setShowing(!!state.translation);
			} catch {
				if (current()) setError(FAILED);
			} finally {
				if (current()) setBusy(null);
			}
		},
		[messageId],
	);

	const off = availability === "ai_off";
	const shown = showing && !off ? translation : null;
	const translate = () => {
		if (translation?.target === target) setShowing(true);
		else if (busy === null && !blocked) void request({ target, quoted: false });
	};
	const chooseTarget = (next: string) => {
		setChosen(next);
		// Already reading a translation: the new language follows at once.
		if (shown && busy === null && !blocked) void request({ target: next, quoted: false });
	};
	return {
		detected,
		target,
		// Another card may have changed the choice; this one still says what it shows.
		pickerTarget: shown?.target ?? target,
		chooseTarget,
		offered: availability === "ready" && !dismissed && offersTranslation(detected, [...reading, ...never], target),
		dismiss: () => setDismissed(true),
		neverOffered: !!detected && never.includes(detected),
		toggleNeverOffered: () => {
			if (!detected) return;
			setJustStopped(!never.includes(detected));
			setNever(toggledLanguage(never, detected));
		},
		justStopped,
		translation: off ? null : translation,
		shown,
		busy,
		error,
		failure,
		blocked,
		translate,
		translateQuoted: () => void request({ target: shown?.target ?? target, quoted: true }),
		showOriginal: () => setShowing(false),
		retry:
			busy === null && !blocked && retryable
				? () => {
						if (lastRequest.current) void request(lastRequest.current);
					}
				: undefined,
		menu:
			availability === "hidden"
				? undefined
				: {
						label: shown ? "Show untranslated" : "Translate",
						disabledReason: translationDisabledReason(availability),
						onSelect: () => (shown ? setShowing(false) : translate()),
					},
	};
}
