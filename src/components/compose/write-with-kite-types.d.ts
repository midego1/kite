import type { ComposeThreading } from "./types";

/** What Write with Kite reads from and writes to the composer. */
export type WriteWithKiteComposer = {
	html: string;
	setHtml: (html: string) => void;
	subject: string;
	to: string[];
	threading: ComposeThreading | null;
	/** Called once Kite's text is in the message, so the send can tell the writing style profile to skip it. */
	onInserted?: () => void;
};

/** The selection in the editor when the panel opened, clipped to the text before the signature. */
export type WriteWithKiteSelection = { range: Range; text: string; html: string };

export type WriteWithKitePanelProps = {
	editorId: string;
	mailboxId: string;
	composer: WriteWithKiteComposer;
	selection: WriteWithKiteSelection | null;
	onClose: () => void;
};
