"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { TOAST_ACTION_CLASS, TOAST_CORNER_CLASS, TOAST_SURFACE_CLASS } from "@/components/ui/toast-styles";
import { requestSendNow } from "./send-now-client";
import { UNDO_SAFETY_MARGIN_MS, sentMessageHref, undoCountdownSeconds } from "./undo-send-utils";
import type { SendingBarProps, UndoSendBarProps } from "./undo-send-types";

const BAR_CLASS = `${TOAST_CORNER_CLASS} ${TOAST_SURFACE_CLASS} z-[60] flex items-center gap-4`;

export function SendingBar({ onUndo, undoRequested }: SendingBarProps) {
	return (
		<div role="status" className={BAR_CLASS}>
			<span>{undoRequested ? "Undoing…" : "Sending…"}</span>
			{onUndo && !undoRequested && (
				<button type="button" className={TOAST_ACTION_CLASS} onClick={onUndo}>
					Undo
				</button>
			)}
		</div>
	);
}

export function UndoSendBar({ pending, onUndo, onExpire }: UndoSendBarProps) {
	const { until, messageId, snapshot } = pending;
	const [now, setNow] = useState(() => Date.now());
	const [sendingNow, setSendingNow] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const remainingMs = until - UNDO_SAFETY_MARGIN_MS - now;

	useEffect(() => {
		if (remainingMs <= 0) {
			onExpire();
			// The queue releases the message just after the bar hides: refresh Sent so it no longer reads "Sending…".
			setTimeout(() => window.dispatchEvent(new Event("kite:messages-changed")), UNDO_SAFETY_MARGIN_MS + 1500);
			return;
		}
		const timer = setTimeout(() => setNow(Date.now()), Math.min(250, remainingMs));
		return () => clearTimeout(timer);
	}, [onExpire, remainingMs]);

	async function sendNow() {
		setSendingNow(true);
		setError(null);
		const outcome = await requestSendNow(messageId);
		if (!outcome.ok) {
			setSendingNow(false);
			setError(outcome.error);
			return;
		}
		window.dispatchEvent(new Event("kite:messages-changed"));
		onExpire();
	}

	if (remainingMs <= 0) return null;
	return (
		<div role="status" className={BAR_CLASS}>
			<span className="flex min-w-0 items-baseline gap-1">
				<span className="shrink-0">{error ?? `Sending in ${undoCountdownSeconds(until, now)}s:`}</span>
				<Link href={sentMessageHref(messageId)} className="min-w-0 max-w-56 truncate underline">
					{snapshot.subject || "(no subject)"}
				</Link>
			</span>
			<button type="button" className={TOAST_ACTION_CLASS} onClick={() => void sendNow()} disabled={sendingNow}>
				Send now
			</button>
			<button type="button" className={TOAST_ACTION_CLASS} onClick={onUndo} disabled={sendingNow}>
				Undo
			</button>
		</div>
	);
}
