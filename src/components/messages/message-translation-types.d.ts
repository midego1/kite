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
	chooseTarget: (next: string) => void;
	/** The bar offers a translation of this message. */
	offered: boolean;
	dismiss: () => void;
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
