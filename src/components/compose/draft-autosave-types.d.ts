/**
 * Saves a snapshot to the draft `draftId` (null: create one) and resolves to
 * the draft's id, or null when the save failed. `stale()` turns true once the
 * queue was cancelled or reset, so the save can skip work nobody will use.
 */
export type DraftSave<T> = (snapshot: T, draftId: string | null, stale: () => boolean) => Promise<string | null>;

export type DraftSaveQueue<T> = {
	/** The draft the next save updates. */
	readonly draftId: string | null;
	/** Saves `snapshot` after any save in flight, replacing a snapshot still waiting. */
	enqueue(snapshot: T): Promise<void>;
	/** Resolves once no save is running or waiting. */
	idle(): Promise<void>;
	/** Drops a waiting snapshot; a save in flight still finishes and keeps its id. */
	skip(): void;
	/**
	 * Drops a waiting snapshot and abandons the save in flight (a draft it creates
	 * is discarded), then resolves with the draft id once that save has finished.
	 */
	cancel(): Promise<string | null>;
	/** Abandons pending work and makes `draftId` the draft later saves update. */
	reset(draftId: string | null): void;
};

export type RequestedDraftKey<T> = {
	/** The draft and content the draft will hold once every save asked for has finished; null when unknown. */
	readonly key: string | null;
	/** Whether a snapshot with this key differs from that. */
	needsSave(candidate: string): boolean;
	/** Records that `snapshot` was queued to be saved, whose result is `key` (the id the draft will have). */
	request(snapshot: T, key: string): void;
	/** Records the answer for `snapshot` (null: it failed or was abandoned); ignored once a newer one was requested. */
	settle(snapshot: T, storedKey: string | null): void;
	/** Forgets what the draft holds, after a waiting snapshot was dropped. */
	forget(): void;
};
