import { DEFAULT_FOLDER_COLOR } from "@/lib/folders/colors";

/** The icon rail's one icon size, in pixels. */
export const RAIL_ICON_SIZE = 18;

/**
 * Every item in the collapsed icon rail: the same 40px rounded square, centred on the rail's axis, so hover,
 * active and focus states are the same shape for the menu button, New email, the folders and the account.
 */
export const RAIL_ITEM_CLASS = "relative mx-auto flex h-10 w-10 shrink-0 items-center justify-center rounded-xl p-0";

/** The rail's tooltip wrapper: a block that centres its item, whatever block or flex parent holds it. */
export const RAIL_TOOLTIP_CLASS = "flex w-full justify-center";

/**
 * A count as a small pill on the item's top right corner, above the glyph rather than over it (the 18px icon spans 11 to 29px of
 * the 40px square, the 16px pill ends at 10px).
 */
export const RAIL_BADGE_CLASS =
	"pointer-events-none absolute -right-1.5 -top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-blue-600 px-1 text-[10px] font-semibold leading-none tabular-nums text-white";

export function railBadgeLabel(count: number): string {
	return count > 99 ? "99+" : String(count);
}

/**
 * A folder's icon colour in the rail. A folder stores a colour either way (the create dialog and the column
 * default are both the default blue), so a pick of that blue cannot be told from no choice: the default blue
 * stays as neutral as the system folders, and any other colour tints the icon as in the expanded sidebar.
 */
export function railIconColor(color: string | undefined): string | undefined {
	return color && color.toLowerCase() !== DEFAULT_FOLDER_COLOR ? color : undefined;
}
