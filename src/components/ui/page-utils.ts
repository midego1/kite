// The Zero look's page parts, for markup that cannot use the components in `page.tsx` (forms, tables).

/** A bordered card on the page panel. */
export const CARD_CLASS = "rounded-xl border border-neutral-200 bg-white";

/** A bordered card with the usual padding. */
export const PADDED_CARD_CLASS = `${CARD_CLASS} p-5`;

/** One setting inside a card: a label and its line beside a switch or a select. */
export const SETTING_ROW_CLASS = "flex items-start gap-3 rounded-lg border border-neutral-200 p-4";

/** A quiet, filled note inside a card. */
export const NOTE_CLASS = "rounded-lg bg-[#f6f8fc] p-4 text-sm text-neutral-600";

/** A table's header row: small muted labels on the muted fill. */
export const TABLE_HEAD_CLASS = "border-b border-neutral-200 bg-[#f6f8fc] text-xs font-medium text-neutral-500";
