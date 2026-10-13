import { CalendarClock, CalendarDays, Download, Puzzle, type LucideIcon } from "lucide-react";
import { CLIENT_MODULES } from "@/lib/modules/client-data";
import type { ModuleId } from "@/lib/modules/module-types";
import type { ModuleClient } from "./client-registry-types";

/** Icons a manifest names in `nav[].icon`; the manifest stays data and this file stays the only place that knows the glyphs. */
const NAV_ICONS: Record<string, LucideIcon> = { CalendarClock, CalendarDays, Download };

export function resolveNavIcon(name: string): LucideIcon {
	return NAV_ICONS[name] ?? Puzzle;
}

/**
 * Lazy client chunks, one per module that has client code. The inline `typeof window` check at each
 * `import()` is what lets the server build drop the chunk; a helper around `import()` would not.
 */
const MODULE_CLIENTS: Partial<Record<ModuleId, () => Promise<ModuleClient>>> = {
	calendar: () => (typeof window === "undefined" ? new Promise<never>(() => {}) : import("./calendar/client")),
	booking: () => (typeof window === "undefined" ? new Promise<never>(() => {}) : import("./booking/client")),
	templates: () => (typeof window === "undefined" ? new Promise<never>(() => {}) : import("./templates/client")),
};

/** The module's client chunk, or null when it has none. Call only for a module that is on. */
export function loadModuleClient(id: ModuleId): Promise<ModuleClient> | null {
	return MODULE_CLIENTS[id]?.() ?? null;
}

/** The module that declares this suggestion kind, or null for kinds core draws itself. */
export function suggestionKindModule(kind: string): ModuleId | null {
	return CLIENT_MODULES.find((entry) => entry.suggestionKinds?.includes(kind))?.id ?? null;
}
