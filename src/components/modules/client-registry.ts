import { CalendarClock, CalendarDays, Download, Puzzle, type LucideIcon } from "lucide-react";

/** Icons a manifest names in `nav[].icon`; the manifest stays data and this file stays the only place that knows the glyphs. */
const NAV_ICONS: Record<string, LucideIcon> = { CalendarClock, CalendarDays, Download };

export function resolveNavIcon(name: string): LucideIcon {
	return NAV_ICONS[name] ?? Puzzle;
}
