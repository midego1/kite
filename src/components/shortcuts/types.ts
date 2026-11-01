import type React from "react";
import type { CommandParamField, CommandParamValues } from "@/lib/modules/module-types";

export type ModifierKey = "ctrl" | "meta" | "alt" | "shift";

export interface ShortcutDefinition {
	key: string; // e.g., 'j', 'k', 'e', 'c', '?', '/' or sequences like 'g i'
	label: string; // e.g., 'Next conversation'
	category: "Navigation" | "Actions" | "Composing" | "Selection" | "General";
	description?: string;
	modifiers?: ModifierKey[];
	allowInInputs?: boolean;
	action: () => void;
}

/** A key the help sheet lists; mail keys are bound by the list and the reader, not the provider. */
export type ShortcutHint = Pick<ShortcutDefinition, "key" | "label" | "category" | "modifiers">;

export interface CommandItem {
	id: string;
	title: string;
	subtitle?: string;
	/** The palette group heading. */
	category: string;
	/** The module that owns the command; `core` or absent for core's own and registered commands. */
	moduleId?: string;
	/** What running it does (`navigate`, `read`, `fill`, ...), which picks the row's type badge. */
	effect?: string;
	/** The page a route command opens, so a settings page listed by the palette is not listed twice. */
	href?: string;
	icon?: React.ComponentType<{ className?: string }>;
	shortcut?: string;
	keywords?: string[];
	/** Values the palette asks for before running; none means it runs on selection. */
	params?: CommandParamField[];
	/** Returns a message when the command could not run, which the palette shows instead of closing. */
	perform: (values?: CommandParamValues) => void | string | Promise<void | string>;
}

export interface ShortcutsSettingsResponse {
	enabled?: boolean;
	error?: unknown;
}
