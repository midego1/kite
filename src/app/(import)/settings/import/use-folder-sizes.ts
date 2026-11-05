"use client";

import { useEffect, useRef, useState } from "react";
import { maxSizeSteps } from "@/lib/import/folder-size-utils";
import type { FolderToMeasure } from "./size-utils";
import { fetchFolderSizeStep, foldersToMeasure, plannedTotals } from "./size-utils";
import type { AccountPlan, FolderSizeState } from "./types";

type Source = { key: number; body: Record<string, unknown> };
type Saved = {
	cursor: number | null;
	messages: number;
	bytes: number;
	unsized: number;
	progress: number;
	steps: number;
	uidValidity: number | null;
};

/** A step that threw is tried again this many times, a moment apart, before the folder is marked failed. */
const STEP_RETRIES = 2;
const RETRY_DELAY_MS = 1500;

const fresh = (): Saved => ({
	cursor: null,
	messages: 0,
	bytes: 0,
	unsized: 0,
	progress: 0,
	steps: 0,
	uidValidity: null,
});

function sleep(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		const timer = setTimeout(resolve, ms);
		signal.addEventListener("abort", () => (clearTimeout(timer), resolve()), { once: true });
	});
}

/**
 * Measures the size of the `wanted` folders (ticked, no STATUS=SIZE from the server) one step at a time, newest first,
 * one folder after another, and returns each folder's state for the table and the totals. A folder takes about one
 * request per 10,000 messages and gives up after `maxSizeSteps`; closing the page or leaving the mode stops it, ticking
 * another folder adds it, and a folder that was started carries on where it stopped. A step that throws is retried
 * twice; then the folder is `failed` and is tried again from where it stopped when the effect next runs (a tick, or the
 * folders read again). A server that cannot be measured this way marks the folder `unavailable`. A changed
 * UIDVALIDITY starts that folder again. Nothing here ever blocks the import.
 */
function useMeasuredSizes(source: Source | null, wanted: FolderToMeasure[]): Record<string, FolderSizeState> {
	const [sizes, setSizes] = useState<Record<string, FolderSizeState>>({});
	const saved = useRef(new Map<string, Saved>());
	const finished = useRef(new Set<string>());
	const sourceKey = useRef<number | null>(null);
	const wantedKey = JSON.stringify(wanted);

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
		const { signal } = controller;
		const publish = (name: string, status: FolderSizeState["status"]) => {
			const { messages, bytes, unsized, progress } = saved.current.get(name) ?? fresh();
			if (!signal.aborted)
				setSizes((current) => ({ ...current, [name]: { status, messages, bytes, unsized, progress } }));
		};

		/** One step, retried; null when it cannot be done now. */
		async function step(name: string, progress: Saved) {
			for (let attempt = 0; ; attempt += 1) {
				try {
					return await fetchFolderSizeStep(source!.body, name, progress.cursor, signal);
				} catch {
					if (signal.aborted || attempt >= STEP_RETRIES) return null;
					await sleep(RETRY_DELAY_MS * (attempt + 1), signal);
				}
			}
		}

		async function measure({ name, messages }: FolderToMeasure) {
			let progress = saved.current.get(name) ?? fresh();
			saved.current.set(name, progress);
			const limit = maxSizeSteps(messages);
			while (!signal.aborted) {
				publish(name, "measuring");
				const answer = await step(name, progress);
				if (signal.aborted) return;
				if (!answer) return publish(name, "failed");
				if ("unavailable" in answer || progress.steps >= limit) {
					finished.current.add(name);
					return publish(name, "unavailable");
				}
				if (progress.uidValidity !== null && answer.uidValidity !== progress.uidValidity) {
					// The server rebuilt the folder between steps: what was counted belongs to other messages.
					progress = { ...fresh(), steps: progress.steps + 1, uidValidity: answer.uidValidity };
					saved.current.set(name, progress);
					continue;
				}
				progress.uidValidity = answer.uidValidity;
				progress.messages += answer.messages;
				progress.bytes += answer.bytes;
				progress.unsized += answer.unsized;
				progress.progress = answer.progress;
				progress.cursor = answer.nextCursor;
				progress.steps += 1;
				if (answer.done) {
					finished.current.add(name);
					return publish(name, "done");
				}
			}
		}

		void (async () => {
			for (const folder of wantedKey ? (JSON.parse(wantedKey) as FolderToMeasure[]) : []) {
				if (finished.current.has(folder.name)) continue;
				await measure(folder);
				if (signal.aborted) return;
			}
		})();
		return () => controller.abort();
	}, [source, wantedKey]);

	return sizes;
}

/** Measures the plan's ticked folders that have no size from the server, and adds up the table's rows. */
export function useFolderSizes(source: Source | null, plan: AccountPlan | null) {
	const sizes = useMeasuredSizes(source, plan ? foldersToMeasure(plan.folders) : []);
	return { sizes, totals: plan ? plannedTotals(plan.folders, sizes) : null };
}
