"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { primaryLanguage } from "@/lib/agent/summaries/summary-utils";
import type { SummaryScope, SummaryState } from "@/lib/agent/summaries/summary-types";
import { useKeyChanged } from "@/hooks/use-synced-state";
import type { AiErrorBody } from "@/lib/agent/ai-error-utils";
import type { ThreadSummaryBusy, ThreadSummaryController } from "./thread-summary-types";
import { canSummarize, summaryError, summaryUrl } from "./thread-summary-utils";

function browserLanguage(): string | null {
	return typeof navigator === "undefined" ? null : primaryLanguage(navigator.language);
}

/**
 * Reloads the summary state when the conversation may have changed: new or moved mail (`kite:messages-changed`,
 * which realtime events and local actions dispatch) and the window regaining focus.
 */
function useRefreshSignal(): [number, () => void] {
	const [signal, setSignal] = useState(0);
	const bump = useCallback(() => setSignal((value) => value + 1), []);
	useEffect(() => {
		window.addEventListener("kite:messages-changed", bump);
		window.addEventListener("focus", bump);
		return () => {
			window.removeEventListener("kite:messages-changed", bump);
			window.removeEventListener("focus", bump);
		};
	}, [bump]);
	return [signal, bump];
}

/**
 * The open message's summary: loads the cached one (no model call), makes one when asked, translates it into the
 * browser's language when asked. `defaultScope` is the conversation when it has more than one message. Answers
 * that arrive after the reader moved to another message or scope are dropped.
 */
export function useThreadSummary(messageId: string, defaultScope: SummaryScope): ThreadSummaryController {
	const [scope, setScope] = useState<SummaryScope>(defaultScope);
	const [state, setState] = useState<SummaryState | null>(null);
	const [busy, setBusy] = useState<ThreadSummaryBusy>(null);
	const [error, setError] = useState<string | null>(null);
	const [failure, setFailure] = useState<AiErrorBody | null>(null);
	const lastRequest = useRef<{
		kind: Exclude<ThreadSummaryBusy, null>;
		scope: SummaryScope;
		translateTo?: string;
	} | null>(null);
	const [blocked, setBlocked] = useState<string | null>(null);
	const [hidden, setHidden] = useState(false);
	const [language] = useState(browserLanguage);
	const [refresh, refetch] = useRefreshSignal();
	// What the reader shows now; a request started for anything else is stale when it ends.
	const shownKey = useRef(`${messageId}:${scope}`);
	if (useKeyChanged(`${messageId}:${defaultScope}`)) {
		setScope(defaultScope);
		setState(null);
		setBusy(null);
		setError(null);
		setFailure(null);
		setBlocked(null);
		setHidden(false);
	}

	useEffect(() => {
		shownKey.current = `${messageId}:${scope}`;
		let live = true;
		void fetch(summaryUrl(messageId, scope, language), { cache: "no-store" })
			.then((response) => (response.ok ? (response.json() as Promise<SummaryState>) : null))
			.then((next) => {
				if (live && next) setState(next);
			})
			.catch(() => undefined);
		return () => {
			live = false;
		};
	}, [messageId, scope, language, refresh]);

	const post = useCallback(
		async (kind: Exclude<ThreadSummaryBusy, null>, body: { scope: SummaryScope; translateTo?: string }) => {
			const key = `${messageId}:${body.scope}`;
			const current = () => shownKey.current === key;
			setBusy(kind);
			setError(null);
			setFailure(null);
			lastRequest.current = { kind, ...body };
			try {
				const response = await fetch(`/api/messages/${encodeURIComponent(messageId)}/summary`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ language, ...body }),
				});
				if (!current()) return;
				if (!response.ok) {
					const { message, failure: details } = await summaryError(response);
					if (!current()) return;
					setFailure(details);
					if (response.status === 429) setBlocked(message);
					// The conversation changed under the request: show what is there now, with Summarize again.
					if (response.status === 409) refetch();
					setError(message);
					return;
				}
				const next = (await response.json()) as SummaryState;
				if (!current()) return;
				setState(next);
				setHidden(false);
			} catch {
				if (current()) setError("Kite could not summarize this. Try again.");
			} finally {
				if (current()) setBusy(null);
			}
		},
		[messageId, language, refetch],
	);

	const summarize = (next: SummaryScope = scope) => {
		setHidden(false);
		if (next !== scope) {
			shownKey.current = `${messageId}:${next}`;
			setScope(next);
			setState(null);
		}
		const fresh = next === scope && state?.summary && !state.summary.stale;
		if (!fresh) void post("summarize", { scope: next });
	};

	return {
		scope,
		state,
		busy,
		error,
		failure,
		blocked,
		hidden,
		language,
		summarize,
		summarizeMessage: canSummarize(state) ? () => summarize("message") : undefined,
		translate: () => {
			if (language) void post("translate", { scope, translateTo: language });
		},
		retry:
			busy === null && !blocked
				? () => {
						const last = lastRequest.current;
						if (last?.scope === scope) void post(last.kind, { scope: last.scope, translateTo: last.translateTo });
					}
				: undefined,
		hide: () => setHidden(true),
	};
}
