// The Zero look's page parts, for markup that cannot use the components in `page.tsx` (forms, tables).

/** A bordered card on the page panel. */
export const CARD_CLASS = "rounded-xl border border-neutral-200 bg-white";

/** One setting inside a card: a label and its line beside a switch or a select, on the muted fill. */
export const SETTING_ROW_CLASS = "flex items-start gap-3 rounded-lg bg-neutral-50 p-4";

/** A table's header row: small muted labels on the muted fill. */
export const TABLE_HEAD_CLASS = "border-b border-neutral-200 bg-[#f6f8fc] text-xs font-medium text-neutral-500";

/**
 * An outline button on a tinted row or notice: an opaque face and, when disabled, readable grey text instead of half
 * opacity, so it keeps WCAG AA contrast (the DNS rows of Admin → Domains, the usage statistics notice).
 */
export const ROW_BUTTON_CLASS =
	"bg-white text-neutral-900 disabled:bg-neutral-50 disabled:text-neutral-500 disabled:opacity-100";
