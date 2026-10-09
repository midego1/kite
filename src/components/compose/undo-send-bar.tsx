"use client";

import { useEffect, useState } from "react";
import type { SendingBarProps, UndoSendBarProps } from "./undo-send-types";

const BAR_CLASS =
	"fixed bottom-6 left-1/2 z-[60] flex -translate-x-1/2 items-center gap-4 rounded-lg bg-neutral-900 px-4 py-3 text-sm text-white shadow-lg";

export function SendingBar({ onUndo, undoRequested }: SendingBarProps) {
	return (
		<div role="status" className={BAR_CLASS}>
			<span>{undoRequested ? "Undoing…" : "Sending…"}</span>
			{onUndo && !undoRequested && (
				<button type="button" className="font-semibold text-blue-300 hover:text-blue-200" onClick={onUndo}>
					Undo
				</button>
			)}
		</div>
	);
}

// Hide the button slightly before the queue releases the message, so a late
// click does not race the delivery and come back as "already sent".
const SAFETY_MARGIN_MS = 750;

export function UndoSendBar({ until, onUndo, onExpire }: UndoSendBarProps) {
	const [now, setNow] = useState(() => Date.now());
	const remainingMs = until - SAFETY_MARGIN_MS - now;

	useEffect(() => {
		if (remainingMs <= 0) {
			onExpire();
			return;
		}
		const timer = setTimeout(() => setNow(Date.now()), Math.min(250, remainingMs));
		return () => clearTimeout(timer);
	}, [onExpire, remainingMs]);

	if (remainingMs <= 0) return null;
	return (
		<div role="status" className={BAR_CLASS}>
			<span>Sending in {Math.ceil(remainingMs / 1000)}s</span>
			<button type="button" className="font-semibold text-blue-300 hover:text-blue-200" onClick={onUndo}>
				Undo
			</button>
		</div>
	);
}
