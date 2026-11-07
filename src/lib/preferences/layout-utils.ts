import { isInterfaceLanguageChoice } from "@/lib/i18n/language-utils";
import type { LayoutLabelColor, LayoutLabelColors, LayoutPreferences } from "./layout-types";

/** The sizes the resizable message list accepts (`message-split-layout.tsx`). */
export const LIST_WIDTH_LIMITS = { min: 250, max: 1200 };
export const LIST_HEIGHT_LIMITS = { min: 120, max: 1200 };

const READING_PANES = new Set(["none", "right", "below"]);
const DENSITIES = new Set(["default", "comfortable", "compact"]);
const LIST_LABELS = new Set(["compact", "full", "off"]);
/** Kept in step with `LABEL_COLORS` (checked by `tests/label-colors.test.mjs`). */
const LABEL_COLOR_IDS: readonly LayoutLabelColor[] = [
	"blue",
	"purple",
	"pink",
	"red",
	"orange",
	"amber",
	"green",
	"teal",
];
const LABEL_COLOR_SET = new Set<string>(LABEL_COLOR_IDS);
/** A guard against a hand-edited or runaway value: far more than anyone has mailboxes or connected accounts. */
const MAX_LABEL_COLOR_ENTRIES = 200;
const MAX_LABEL_COLOR_KEY_LENGTH = 100;
/** The values of `FONT_PREFERENCE`, `EMAIL_FONT_PREFERENCE` and `FONT_SCOPE_PREFERENCE` (checked by `tests/appearance-font.test.mjs`). */
const FONTS = new Set(["auto", "manrope", "geist", "inter", "system", "opendyslexic"]);
const EMAIL_FONTS = new Set(["original", "reader"]);
const FONT_SCOPES = new Set(["text", "everywhere"]);
const INTERFACE_DIRECTIONS = new Set(["auto", "ltr", "rtl"]);
/** The choices that are one of a few words, by layout key. */
const CHOICES: readonly (readonly [keyof LayoutPreferences, ReadonlySet<string>])[] = [
	["readingPane", READING_PANES],
	["density", DENSITIES],
	["listLabels", LIST_LABELS],
	["font", FONTS],
	["emailFont", EMAIL_FONTS],
	["fontScope", FONT_SCOPES],
	["interfaceDirection", INTERFACE_DIRECTIONS],
];
const LANGUAGE_CODE = /^[a-z]{2}$/;
const MAX_LANGUAGES_NEVER_OFFERED = 40;

function size(value: unknown, limits: { min: number; max: number }): number | undefined {
	if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
	return Math.round(Math.max(limits.min, Math.min(limits.max, value)));
}

function labelColorMap(value: unknown): Record<string, LayoutLabelColor> | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const colors: Record<string, LayoutLabelColor> = {};
	for (const [id, color] of Object.entries(value)) {
		if (Object.keys(colors).length >= MAX_LABEL_COLOR_ENTRIES) break;
		if (id && id.length <= MAX_LABEL_COLOR_KEY_LENGTH && typeof color === "string" && LABEL_COLOR_SET.has(color))
			colors[id] = color as LayoutLabelColor;
	}
	return colors;
}

/** Colours by mailbox and by account; each map keeps only valid entries, and `{}` means "no colour chosen". */
function parseLabelColors(value: unknown): LayoutLabelColors | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const input = value as Record<string, unknown>;
	const colors: LayoutLabelColors = {};
	const mailboxes = labelColorMap(input.mailboxes);
	if (mailboxes && Object.keys(mailboxes).length) colors.mailboxes = mailboxes;
	const accounts = labelColorMap(input.accounts);
	if (accounts && Object.keys(accounts).length) colors.accounts = accounts;
	return colors;
}

function parseTranslationChoices(input: Record<string, unknown>): LayoutPreferences {
	const layout: LayoutPreferences = {};
	if (typeof input.translateTo === "string" && LANGUAGE_CODE.test(input.translateTo))
		layout.translateTo = input.translateTo;
	if (Array.isArray(input.translateNever))
		layout.translateNever = input.translateNever
			.filter((code): code is string => typeof code === "string" && LANGUAGE_CODE.test(code))
			.slice(0, MAX_LANGUAGES_NEVER_OFFERED);
	return layout;
}

/**
 * Keeps only well-formed choices, clamping sizes into range. Used on stored JSON and on what a client
 * sends, so an old or hand-edited value can never break a layout.
 */
function parseLayoutPreferences(value: unknown): LayoutPreferences {
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};
	const input = value as Record<string, unknown>;
	const layout: LayoutPreferences = {};
	for (const [key, allowed] of CHOICES) {
		const choice = input[key];
		if (typeof choice === "string" && allowed.has(choice)) Object.assign(layout, { [key]: choice });
	}
	const labelColors = parseLabelColors(input.labelColors);
	if (labelColors) layout.labelColors = labelColors;
	if (typeof input.conversationView === "boolean") layout.conversationView = input.conversationView;
	if (typeof input.onboardingChecklistDismissed === "boolean")
		layout.onboardingChecklistDismissed = input.onboardingChecklistDismissed;
	if (isInterfaceLanguageChoice(input.interfaceLanguage)) layout.interfaceLanguage = input.interfaceLanguage;
	Object.assign(layout, parseTranslationChoices(input));
	const listWidth = size(input.listWidth, LIST_WIDTH_LIMITS);
	if (listWidth !== undefined) layout.listWidth = listWidth;
	const listHeight = size(input.listHeight, LIST_HEIGHT_LIMITS);
	if (listHeight !== undefined) layout.listHeight = listHeight;
	return layout;
}

/** Reads the stored column, which is JSON text; anything unreadable is an empty layout. */
export function parseStoredLayout(text: string | null | undefined): LayoutPreferences {
	if (!text) return {};
	try {
		return parseLayoutPreferences(JSON.parse(text));
	} catch {
		return {};
	}
}

/** The body of `PATCH /api/settings/layout`: `{ layout: {...} }` with at least one valid choice, or null. */
export function parseLayoutPatch(body: unknown): LayoutPreferences | null {
	if (!body || typeof body !== "object") return null;
	const layout = parseLayoutPreferences((body as { layout?: unknown }).layout);
	return Object.keys(layout).length ? layout : null;
}
