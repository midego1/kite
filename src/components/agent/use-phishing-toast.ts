"use client";

import { useEffect, useRef } from "react";
import toast from "react-hot-toast";
import type { CardSuggestion } from "./suggestion-card-types";
import { newPhishingWarnings } from "./suggestion-card-utils";

/**
 * Announces a phishing warning that appears for the open message while it is open. Warnings that
 * were already there when it was opened stay quiet, and so does every other message.
 */
export function usePhishingToast(suggestions: readonly CardSuggestion[] | null, messageId: string) {
	const known = useRef<{ messageId: string; ids: Set<string> | null }>({ messageId, ids: null });

	useEffect(() => {
		if (known.current.messageId !== messageId) known.current = { messageId, ids: null };
		if (!suggestions) return;
		const { known: ids, fresh } = newPhishingWarnings(suggestions, messageId, known.current.ids);
		known.current.ids = ids;
		for (const warning of fresh)
			toast.error("Kite warns that the message you are reading looks like phishing.", {
				id: `kite-phishing-${warning.id}`,
				duration: 8000,
			});
	}, [suggestions, messageId]);
}
