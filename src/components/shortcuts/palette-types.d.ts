import type React from "react";
import type { Message } from "@/hooks/types";
import type { ContactSearchHit } from "@/app/api/contacts/search/search-utils";
import type { CommandParamField, CommandParamValues, ModuleId } from "@/lib/modules/module-types";
import type { ModuleSearchSection } from "@/lib/search/module-search-types";

export type PaletteCategoryId =
	"all" | "pages" | "messages" | "contacts" | "actions" | "settings" | `module:${ModuleId}`;

export type PaletteIcon = React.ComponentType<{ className?: string }>;

export type PaletteCategory = {
	id: PaletteCategoryId;
	label: string;
	icon: PaletteIcon;
	/** Set on a module's category; its rows carry the module's icon when they have none of their own. */
	moduleId?: ModuleId;
};

export type PaletteItem = {
	id: string;
	category: Exclude<PaletteCategoryId, "all">;
	/** The small type badge: PAGE, MESSAGE, CONTACT, ACTION, SETTING, or a module record type such as EVENT. */
	type: string;
	title: string;
	subtitle?: string;
	icon?: PaletteIcon;
	shortcut?: string;
	/** Values the palette asks for before running; none means it runs on selection. */
	params?: CommandParamField[];
	/** Returns a message when the item could not run, which the palette shows instead of closing. */
	perform: (values?: CommandParamValues) => void | string | Promise<void | string>;
};

export type PaletteGroup = { category: PaletteCategory; items: PaletteItem[] };

/** The columns of a message row the palette reads; the list API answers more. */
export type PaletteMessageHit = Pick<
	Message,
	"id" | "subject" | "fromAddr" | "fromContactName" | "toAddr" | "toContactName" | "direction" | "status" | "createdAt"
>;

/** What the mail, contact and module searches answered for the current query; `null` while nothing came back. */
export type PaletteRemoteResults = {
	messages: { items: PaletteMessageHit[]; total: number } | null;
	contacts: { items: ContactSearchHit[]; total: number } | null;
	sections: ModuleSearchSection[];
	loading: boolean;
};

export type PaletteKeyEvent = {
	key: string;
	code: string;
	altKey: boolean;
	ctrlKey: boolean;
	metaKey: boolean;
};
