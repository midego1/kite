/** How a composer docked in the reader leaves it, each with the draft it holds then. */
export type InlineComposerActions = {
	/** Esc or Close: collapse and keep the draft for the reply box to resume. */
	collapse: (draftId: string | null) => void;
	/** Sent (after its undo window) or deleted: close, with nothing left to resume. */
	finish: (draftId: string | null) => void;
	/** Pop out: the saved draft moves into the floating composer. */
	popOut: (draftId: string | null) => void;
	/** Whether it is sending or offering undo, when it must outlive its reader. */
	busyChange: (busy: boolean) => void;
	/** A send was undone; the draft is back in the composer. */
	undone: (draftId: string | null) => void;
};
