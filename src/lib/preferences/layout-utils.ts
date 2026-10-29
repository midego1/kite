import type { LayoutPreferences } from "./layout-types";

/** The sizes the resizable message list accepts (`message-split-layout.tsx`). */
export const LIST_WIDTH_LIMITS = { min: 250, max: 1200 };
export const LIST_HEIGHT_LIMITS = { min: 120, max: 1200 };

const READING_PANES = new Set(["none", "right", "below"]);
const DENSITIES = new Set(["default", "comfortable", "compact"]);

function size(value: unknown, limits: { min: number; max: number }): number | undefined {
	if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
	return Math.round(Math.max(limits.min, Math.min(limits.max, value)));
}

/**
 * Keeps only well-formed choices, clamping sizes into range. Used on stored JSON and on what a client
 * sends, so an old or hand-edited value can never break a layout.
 */
export function parseLayoutPreferences(value: unknown): LayoutPreferences {
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};
	const input = value as Record<string, unknown>;
	const layout: LayoutPreferences = {};
	if (typeof input.readingPane === "string" && READING_PANES.has(input.readingPane))
		layout.readingPane = input.readingPane as LayoutPreferences["readingPane"];
	if (typeof input.density === "string" && DENSITIES.has(input.density))
		layout.density = input.density as LayoutPreferences["density"];
	if (typeof input.conversationView === "boolean") layout.conversationView = input.conversationView;
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
