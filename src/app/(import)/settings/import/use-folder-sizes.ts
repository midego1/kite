"use client";

import { useEffect, useRef, useState } from "react";
import type { FolderSizeState } from "./types";
import { fetchFolderSizeStep } from "./utils";

type Source = { key: number; body: Record<string, unknown> };
type Saved = { cursor: number | null; messages: number; bytes: number; progress: number; uidValidity: number | null };

/**
 * Measures the size of the folders in `wanted` (ticked, no STATUS=SIZE from the server) one step at a time, newest
 * first, one folder after another, and returns each folder's state for the table and the totals. Steps are separate
 * short requests, so a folder of 100,000 messages is about ten of them; closing the page stops it, ticking another
 * folder adds it, and a folder that was started carries on where it stopped. A step that fails or a server that
 * cannot be measured marks that folder `unavailable`; nothing here ever blocks the import.
 */
export function useFolderSizes(source: Source | null, wanted: string[]): Record<string, FolderSizeState> {
	const [sizes, setSizes] = useState<Record<string, FolderSizeState>>({});
	const saved = useRef(new Map<string, Saved>());
	const finished = useRef(new Set<string>());
	const sourceKey = useRef<number | null>(null);
	const wantedKey = wanted.join("\n");

	useEffect(() => {
		if (sourceKey.current !== (source?.key ?? null)) {
			// A new plan (another account, or the folders read again) starts from nothing.
			sourceKey.current = source?.key ?? null;
			saved.current.clear();
			finished.current.clear();
			setSizes({});
		}
		if (!source) return;
		const controller = new AbortController();
		const names = wantedKey ? wantedKey.split("\n") : [];
		const publish = (name: string, state: FolderSizeState) =>
			setSizes((current) => (controller.signal.aborted ? current : { ...current, [name]: state }));

		async function measure(name: string) {
			const progress = saved.current.get(name) ?? {
				cursor: null,
				messages: 0,
				bytes: 0,
				progress: 0,
				uidValidity: null,
			};
			saved.current.set(name, progress);
			for (;;) {
				publish(name, { status: "measuring", ...progress });
				const answer = await fetchFolderSizeStep(
					source!.body,
					name,
					progress.cursor,
					controller.signal,
					progress.uidValidity,
				);
				if (controller.signal.aborted) return;
				if ("unavailable" in answer) {
					finished.current.add(name);
					return void publish(name, { status: "unavailable", ...progress });
				}
				if (answer.reset) Object.assign(progress, { cursor: null, messages: 0, bytes: 0, progress: 0 });
				progress.uidValidity = answer.uidValidity;
				progress.messages += answer.messages;
				progress.bytes += answer.bytes;
				progress.progress = answer.progress;
				progress.cursor = answer.nextCursor;
				if (answer.done) {
					finished.current.add(name);
					return void publish(name, { status: "done", ...progress });
				}
			}
		}

		void (async () => {
			for (const name of names) {
				if (finished.current.has(name)) continue;
				try {
					await measure(name);
				} catch {
					if (controller.signal.aborted) return;
					finished.current.add(name);
					const progress = saved.current.get(name);
					publish(name, {
						status: "unavailable",
						messages: progress?.messages ?? 0,
						bytes: progress?.bytes ?? 0,
						progress: progress?.progress ?? 0,
					});
				}
				if (controller.signal.aborted) return;
			}
		})();
		return () => controller.abort();
	}, [source, wantedKey]);

	return sizes;
}
