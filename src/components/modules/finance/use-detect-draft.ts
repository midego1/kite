"use client";

import { useEffect, useState } from "react";
import { authFetch } from "@/lib/auth/client";
import type { DetectAnswer } from "@/components/finance/dialog-types";

type DraftState = { loading: boolean; error: string | null; answer: DetectAnswer | null };

/** Error text from a failed Money Watch request, with a fallback when the answer has none. */
export async function errorOf(response: Response, fallback: string): Promise<string> {
	const data = (await response.json().catch(() => null)) as { error?: string } | null;
	return data?.error || fallback;
}

/** Reads the message through `POST /api/finance/detect` each time the dialog opens; nothing is stored. */
export function useDetectDraft(messageId: string, open: boolean): DraftState {
	const [state, setState] = useState<DraftState & { key: string | null }>({
		loading: false,
		error: null,
		answer: null,
		key: null,
	});
	const key = open ? messageId : null;
	if (state.key !== key) setState({ loading: key !== null, error: null, answer: null, key });

	useEffect(() => {
		if (!key) return;
		let live = true;
		authFetch("/api/finance/detect", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ messageId: key }),
		})
			.then(async (response) => {
				if (!response.ok) throw new Error(await errorOf(response, "Kite could not read this message."));
				return (await response.json()) as DetectAnswer;
			})
			.then((answer) => {
				if (live) setState({ loading: false, error: null, answer, key });
			})
			.catch((caught: unknown) => {
				if (live)
					setState({
						loading: false,
						error: caught instanceof Error ? caught.message : String(caught),
						answer: null,
						key,
					});
			});
		return () => {
			live = false;
		};
	}, [key]);

	return { loading: state.loading, error: state.error, answer: state.answer };
}
