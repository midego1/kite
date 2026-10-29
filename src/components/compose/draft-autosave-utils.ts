import type { DraftSave, DraftSaveQueue, SavedDraftKey } from "./draft-autosave-types";

/**
 * Runs draft autosaves one at a time. The first save of a new draft is a POST
 * that returns its id; without the queue, an edit made while that POST is in
 * flight would POST again and leave two drafts.
 */
export function createDraftSaveQueue<T>(options: {
	save: DraftSave<T>;
	discard: (draftId: string) => void;
	onDraftId?: (draftId: string) => void;
}): DraftSaveQueue<T> {
	let draftId: string | null = null;
	let pending: { snapshot: T } | null = null;
	let running: Promise<void> | null = null;
	let generation = 0;

	async function drain() {
		// Yield first so `running` is assigned before a synchronous failure could clear it.
		await Promise.resolve();
		try {
			while (pending) {
				const { snapshot } = pending;
				pending = null;
				const started = generation;
				const previous = draftId;
				let saved: string | null = null;
				try {
					saved = await options.save(snapshot, previous, () => started !== generation);
				} catch {
					saved = null;
				}
				if (started !== generation) {
					if (saved && !previous) options.discard(saved);
					continue;
				}
				if (saved && saved !== draftId) {
					draftId = saved;
					options.onDraftId?.(saved);
				}
			}
		} finally {
			running = null;
		}
	}

	function idle() {
		return running ?? Promise.resolve();
	}

	return {
		get draftId() {
			return draftId;
		},
		enqueue(snapshot) {
			pending = { snapshot };
			running ??= drain();
			return running;
		},
		idle,
		skip() {
			pending = null;
		},
		async cancel() {
			pending = null;
			generation += 1;
			await idle();
			return draftId;
		},
		reset(next) {
			pending = null;
			generation += 1;
			draftId = next;
		},
	};
}

/**
 * Remembers the draft and content the last finished save stored, so a snapshot
 * that would write the same again is not saved. That is only true until the
 * next save finishes: a save in flight may replace what the dedupe compared
 * against, so `onSaved` tells the owner to compare the composer's current
 * snapshot again, or a revert made during the request would never be saved.
 */
export function createSavedDraftKey(onSaved: () => void): SavedDraftKey {
	let key: string | null = null;
	return {
		get key() {
			return key;
		},
		needsSave(candidate) {
			return candidate !== key;
		},
		saved(next) {
			key = next;
			onSaved();
		},
	};
}

/** Whether the composer holds anything worth a draft; a body that is only the signature is not. */
export function hasDraftContent(input: {
	recipients: number;
	subject: string;
	quotedHtml: string | null;
	attachments: number;
	bodyText: string;
	signature: string | null | undefined;
}): boolean {
	const body = input.bodyText.trim();
	return (
		input.recipients > 0 ||
		input.subject.trim() !== "" ||
		!!input.quotedHtml ||
		input.attachments > 0 ||
		(body !== "" && body !== (input.signature?.trim() ?? ""))
	);
}

/**
 * Composer files whose id is not in `ids`: with the ids the autosave already
 * tried, the files it should still store on the draft; with the ids it stored,
 * the files a send must upload itself.
 */
export function withoutAttachmentIds<A extends { id: string }>(
	attachments: readonly A[],
	ids: ReadonlySet<string>,
): A[] {
	return attachments.filter((attachment) => !ids.has(attachment.id));
}
