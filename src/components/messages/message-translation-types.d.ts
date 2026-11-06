import type { AiErrorBody } from "@/lib/agent/ai-error-utils";
import type { MessageTranslation } from "@/lib/agent/translation/translation-types";

/** `ready` can translate, `ai_off` keeps the menu entry greyed out with the reason, `hidden` shows nothing. */
export type TranslationAvailability = "ready" | "ai_off" | "hidden";

export type TranslationBody = {
	subject?: string | null;
	textBody?: string | null;
	htmlBody?: string | null;
};

export type MessageTranslationInput = {
	messageId: string;
	/** Null until the body is there, or while a card is collapsed: nothing is detected then. */
	body: TranslationBody | null;
	availability: TranslationAvailability;
};

/** The entry in a message's More menu. */
export type MessageTranslateMenu = {
	label: string;
	/** Shown instead of acting: AI is off for the mailbox. */
	disabledReason?: string;
	onSelect: () => void;
};

export type MessageTranslationController = {
	/** The language detected in the browser, or null when unsure. */
	detected: string | null;
	target: string;
	/** What the picker shows: the shown translation's language, else `target`. */
	pickerTarget: string;
	chooseTarget: (next: string) => void;
	/** The bar offers a translation of this message. */
	offered: boolean;
	/** Waves the offer off for this message. */
	dismiss: () => void;
	/** This message's language is one the reader asked not to be offered. */
	neverOffered: boolean;
	/** Stops offering this message's language, or starts again. */
	toggleNeverOffered: () => void;
	/** The language was taken off the offer just now, here: the bar stays a moment longer to undo it. */
	justStopped: boolean;
	translation: MessageTranslation | null;
	/** The translation on screen; null while the original is. */
	shown: MessageTranslation | null;
	busy: "translate" | "quoted" | null;
	error: string | null;
	failure: AiErrorBody | null;
	/** A cap or the rate limit refused the last request. */
	blocked: boolean;
	translate: () => void;
	translateQuoted: () => void;
	showOriginal: () => void;
	retry: (() => void) | undefined;
	/** Undefined where Translate is not offered at all. */
	menu: MessageTranslateMenu | undefined;
};
