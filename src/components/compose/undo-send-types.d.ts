import type { ComposeThreading } from "./types";

export type PendingUndoSnapshot = {
	to: string[];
	cc: string[];
	bcc: string[];
	showCc: boolean;
	showBcc: boolean;
	threading: ComposeThreading | null;
	subject: string;
	html: string;
	quotedHtml: string | null;
};

export type PendingUndoSend = {
	messageId: string;
	/** Epoch milliseconds when the outbound queue releases the message. */
	until: number;
	snapshot: PendingUndoSnapshot;
};

export type SendingBarProps = {
	/** Present when the undo window is on, so Undo can be pressed before the server answers. */
	onUndo?: () => void;
	undoRequested: boolean;
};

export type UndoSendBarProps = {
	until: number;
	onUndo: () => void;
	onExpire: () => void;
};
