"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { TOAST_ACTION_CLASS, TOAST_CORNER_CLASS, TOAST_SURFACE_CLASS } from "@/components/ui/toast-styles";
import type { ComposeToastState } from "./compose-toast";
import { requestSendNow } from "./send-now-client";
import { UNDO_SAFETY_MARGIN_MS, sentMessageHref, undoCountdownSeconds } from "./undo-send-utils";
import type { SendingBarProps, UndoSendBarProps } from "./undo-send-types";
import { useT } from "@/lib/i18n/use-t";

// The corner class caps the width, so the subject link truncates before the bar runs off a phone.
const BAR_CLASS = `${TOAST_CORNER_CLASS} ${TOAST_SURFACE_CLASS} z-[60] flex items-center gap-4`;

export function SendingBar({ onUndo, undoRequested }: SendingBarProps) {
	const t = useT();
	return (
		<div role="status" className={BAR_CLASS}>
			<span>{undoRequested ? t("Undoing…") : t("Sending…")}</span>
			{onUndo && !undoRequested && (
				<button type="button" className={TOAST_ACTION_CLASS} onClick={onUndo}>
					{t("Undo")}
				</button>
			)}
		</div>
	);
}

export function UndoSendBar({ pending, onUndo, onExpire }: UndoSendBarProps) {
	const t = useT();
	const { until, messageId, snapshot } = pending;
	const [now, setNow] = useState(() => Date.now());
	const [sendingNow, setSendingNow] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [failedFor, setFailedFor] = useState<string | null>(null);
	// The message the bar has finished with, so a window ending, a Send now answer and a dismissal act once between them.
	const settledFor = useRef<string | null>(null);
	const failed = failedFor === messageId;
	const remainingMs = until - UNDO_SAFETY_MARGIN_MS - now;

	const settle = useCallback(
		(toast: ComposeToastState) => {
			if (settledFor.current === messageId) return false;
			settledFor.current = messageId;
			onExpire(toast);
			return true;
		},
		[messageId, onExpire],
	);

	useEffect(() => {
		if (failed) return;
		if (remainingMs <= 0) {
			// The queue releases the message just after the bar hides: refresh Sent so it no longer reads "Sending…".
			if (settle({ type: "success", message: t("Message sent") })) {
				setTimeout(() => window.dispatchEvent(new Event("kite:messages-changed")), UNDO_SAFETY_MARGIN_MS + 1500);
			}
			return;
		}
		const timer = setTimeout(() => setNow(Date.now()), Math.min(250, remainingMs));
		return () => clearTimeout(timer);
	}, [failed, remainingMs, settle, t]);

	async function sendNow() {
		setSendingNow(true);
		setError(null);
		const outcome = await requestSendNow(messageId);
		// The window ended meanwhile (or the bar moved on): the answer no longer concerns anything on screen.
		if (settledFor.current === messageId) return;
		window.dispatchEvent(new Event("kite:messages-changed"));
		if (outcome.ok) {
			settle({ type: "success", message: t("Message sent") });
			return;
		}
		setSendingNow(false);
		setError(outcome.error);
		if (outcome.failed) setFailedFor(messageId);
	}

	if (!failed && remainingMs <= 0) return null;
	return (
		<div role="status" className={BAR_CLASS}>
			<span className="flex min-w-0 items-baseline gap-1">
				<span className="shrink-0 whitespace-nowrap">
					{failed
						? t("Sending failed:")
						: (error ?? t("Sending in {seconds}s:", { seconds: undoCountdownSeconds(until, now) }))}
				</span>
				<Link dir="auto" href={sentMessageHref(messageId)} className="min-w-0 max-w-56 truncate underline">
					{snapshot.subject || t("(no subject)")}
				</Link>
			</span>
			{!failed && (
				<button type="button" className={TOAST_ACTION_CLASS} onClick={() => void sendNow()} disabled={sendingNow}>
					{t("Send now")}
				</button>
			)}
			<button type="button" className={TOAST_ACTION_CLASS} onClick={onUndo} disabled={sendingNow}>
				{failed ? t("Edit") : t("Undo")}
			</button>
			{failed && (
				<button
					type="button"
					className={TOAST_ACTION_CLASS}
					onClick={() => settle({ type: "error", message: error ?? t("Sending failed") })}
				>
					{t("Dismiss")}
				</button>
			)}
		</div>
	);
}
