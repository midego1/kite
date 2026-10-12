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

export interface CommandItem {
	id: string;
	title: string;
	subtitle?: string;
	/** The palette group heading. */
	category: string;
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
