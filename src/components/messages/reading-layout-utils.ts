import type {
	MessageListDensity,
	MessageRowDensityStyle,
	ReadingLayoutOption,
	ReadingPaneMode,
} from "./reading-layout-types";

export const READING_PANE_STORAGE_KEY = "kite-reading-pane";
/** The on/off switch that preceded the reading pane setting; read once to migrate it. */
export const LEGACY_TWO_COLUMN_STORAGE_KEY = "kite-two-column-reading";
export const MESSAGE_DENSITY_STORAGE_KEY = "kite-message-density";

export const DEFAULT_READING_PANE_MODE: ReadingPaneMode = "right";
export const DEFAULT_MESSAGE_DENSITY: MessageListDensity = "default";

/** Viewports narrower than Tailwind's `lg` breakpoint always read in one column. */
export const WIDE_READING_QUERY = "(min-width: 1024px)";

export const READING_PANE_OPTIONS: ReadingLayoutOption<ReadingPaneMode>[] = [
	{ value: "none", label: "No split", description: "The list fills the page and opening an email replaces it." },
	{ value: "right", label: "Right of inbox", description: "The list stays on the left and emails open beside it." },
	{ value: "below", label: "Below inbox", description: "The list stays on top and emails open underneath it." },
];

export const MESSAGE_DENSITY_OPTIONS: ReadingLayoutOption<MessageListDensity>[] = [
	{ value: "default", label: "Default", description: "Balanced spacing with a preview line." },
	{ value: "comfortable", label: "Comfortable", description: "More room around every email." },
	{ value: "compact", label: "Compact", description: "Fit more emails on screen." },
];

export function isReadingPaneMode(value: unknown): value is ReadingPaneMode {
	return value === "none" || value === "right" || value === "below";
}

export function isMessageListDensity(value: unknown): value is MessageListDensity {
	return value === "default" || value === "comfortable" || value === "compact";
}

/**
 * Resolves the stored reading pane, falling back to the old two-column switch:
 * people who had turned it off keep reading in one column.
 */
export function parseReadingPaneMode(stored: string | null, legacyTwoColumn: string | null): ReadingPaneMode {
	if (isReadingPaneMode(stored)) return stored;
	if (legacyTwoColumn === "off") return "none";
	if (legacyTwoColumn === "on") return "right";
	return DEFAULT_READING_PANE_MODE;
}

export function parseMessageListDensity(stored: string | null): MessageListDensity {
	return isMessageListDensity(stored) ? stored : DEFAULT_MESSAGE_DENSITY;
}

export function getEffectiveReadingPaneMode(mode: ReadingPaneMode, wideViewport: boolean): ReadingPaneMode {
	return wideViewport ? mode : "none";
}

/** Keeps a resizable list between its minimum and what leaves `reserved` pixels for the reading pane. */
export function clampListSize(requested: number, min: number, containerSize: number, reserved: number): number {
	return Math.max(min, Math.min(requested, Math.max(min, containerSize - reserved)));
}

/** Row spacing for the stacked rows of the list beside a reading pane. */
export function getStackedRowDensity(density: MessageListDensity): MessageRowDensityStyle {
	if (density === "comfortable") return { rowClassName: "py-4", showPreview: true };
	if (density === "compact") return { rowClassName: "py-2", showPreview: false };
	return { rowClassName: "py-3", showPreview: true };
}

/** Row height for the single-line rows of a full-width list. */
export function getWideRowDensity(density: MessageListDensity): MessageRowDensityStyle {
	if (density === "comfortable") return { rowClassName: "min-h-14", showPreview: true };
	if (density === "compact") return { rowClassName: "min-h-9", showPreview: true };
	return { rowClassName: "min-h-12", showPreview: true };
}
