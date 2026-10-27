"use client";

import { useEffect, useRef, useState } from "react";
import type { InlineComposerActions } from "./inline-composer-types";

/**
 * A docked reply after Send: hidden while it sends, offers undo or undoes (`sentInline`, `undoing`), and kept
 * mounted all that time, even without its reader (`busyChange`). Once all of that is over it finishes with the
 * sent draft's id, which is then never offered to resume.
 */
export function useInlineSendLifecycle(
	inline: InlineComposerActions | undefined,
	state: { sending: boolean; pendingUndo: boolean; toast: boolean },
) {
	const [sentInline, setSentInline] = useState(false);
	// Between the Undo click and the server's answer the reply is neither sent nor back.
	const [undoing, setUndoing] = useState(false);
	const sentDraftId = useRef<string | null>(null);
	const { sending, pendingUndo, toast } = state;
	const busy = sending || sentInline || pendingUndo || undoing;
	const done = sentInline && !sending && !pendingUndo && !undoing && !toast;

	useEffect(() => {
		if (done) inline?.finish(sentDraftId.current);
	}, [done, inline]);

	const busyChange = inline?.busyChange;
	useEffect(() => {
		busyChange?.(busy);
	}, [busyChange, busy]);

	return { sentInline, setSentInline, setUndoing, sentDraftId };
}
