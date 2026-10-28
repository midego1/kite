import type { ComposeAttachment, ComposeStoredAttachment } from "./types";

/** One attachment of the composer, either still a local file or already stored on the draft. */
export type ComposeAttachmentEntry =
	{ kind: "local"; id: string; file: File } | { kind: "stored"; id: string; stored: ComposeStoredAttachment };

export interface ComposeAttachmentListProps {
	/** The draft the stored files belong to; their preview and download go through its attachment route. */
	draftId: string | null;
	localAttachments: ComposeAttachment[];
	storedAttachments: ComposeStoredAttachment[];
	/** The size limits the notice under the chips is based on. */
	cloudThresholdBytes: number;
	onRemoveLocal: (id: string) => void;
	onRemoveStored: (id: string) => void;
}

export interface ComposeAttachmentChipProps {
	entry: ComposeAttachmentEntry;
	draftId: string | null;
	onPreview: (entry: ComposeAttachmentEntry) => void;
	onRemove: (entry: ComposeAttachmentEntry) => void;
}

export type ComposeAttachmentNotice = "links" | "near-budget";
