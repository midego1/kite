"use client";

import { useCallback, useEffect, useState } from "react";
import { primaryLanguage } from "@/lib/agent/summaries/summary-utils";
import type { SummaryScope, SummaryState } from "@/lib/agent/summaries/summary-types";
import { useKeyChanged } from "@/hooks/use-synced-state";
import type { ThreadSummaryBusy, ThreadSummaryController } from "./thread-summary-types";
import { canSummarize, summaryError, summaryUrl } from "./thread-summary-utils";

function browserLanguage(): string | null {
	return typeof navigator === "undefined" ? null : primaryLanguage(navigator.language);
}

/**
 * The open message's summary: loads the cached one (no model call), makes one when asked, translates it into the
 * browser's language when asked. `defaultScope` is the conversation when it has more than one message.
 */
export function useThreadSummary(messageId: string, defaultScope: SummaryScope): ThreadSummaryController {
	const [scope, setScope] = useState<SummaryScope>(defaultScope);
	const [state, setState] = useState<SummaryState | null>(null);
	const [busy, setBusy] = useState<ThreadSummaryBusy>(null);
	const [error, setError] = useState<string | null>(null);
	const [blocked, setBlocked] = useState<string | null>(null);
	const [hidden, setHidden] = useState(false);
	const [language] = useState(browserLanguage);
	if (useKeyChanged(`${messageId}:${defaultScope}`)) {
		setScope(defaultScope);
		setState(null);
		setError(null);
		setBlocked(null);
		setHidden(false);
	}

	useEffect(() => {
		let live = true;
		void fetch(summaryUrl(messageId, scope, language), { cache: "no-store" })
			.then((response) => (response.ok ? (response.json() as Promise<SummaryState>) : null))
			.then((next) => {
				if (live) setState(next);
			})
			.catch(() => undefined);
		return () => {
			live = false;
		};
	}, [messageId, scope, language]);

	const post = useCallback(
		async (kind: Exclude<ThreadSummaryBusy, null>, body: Record<string, unknown>) => {
			setBusy(kind);
			setError(null);
			try {
				const response = await fetch(`/api/messages/${encodeURIComponent(messageId)}/summary`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ language, ...body }),
				});
				if (!response.ok) {
					const message = await summaryError(response);
					if (response.status === 429) setBlocked(message);
					setError(message);
					return;
				}
				setState((await response.json()) as SummaryState);
				setHidden(false);
			} catch {
				setError("Kite could not summarize this. Try again.");
			} finally {
				setBusy(null);
			}
		},
		[messageId, language],
	);

	const summarize = (next: SummaryScope = scope) => {
		setHidden(false);
		if (next !== scope) {
			setScope(next);
			setState(null);
		}
		const current = next === scope && state?.summary && !state.summary.stale;
		if (!current) void post("summarize", { scope: next });
	};

	return {
		scope,
		state,
		busy,
		error,
		blocked,
		hidden,
		language,
		summarize,
		summarizeMessage: canSummarize(state) ? () => summarize("message") : undefined,
		translate: () => {
			if (language) void post("translate", { scope, translateTo: language });
		},
		hide: () => setHidden(true),
	};
}
