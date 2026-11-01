import { LayoutGrid, Mail, Search, Settings, Users, Zap, type LucideIcon } from "lucide-react";
import type { ContactSearchHit } from "@/app/api/contacts/search/search-utils";
import type { NavSearchGroup } from "@/components/settings/section-nav-types";
import { navModeLabels } from "@/components/settings/section-nav-utils";
import { formatRecipientSummary } from "@/components/messages/utils";
import { getEmailDisplayName } from "@/lib/email/address";
import type { ClientModuleData, ModuleId } from "@/lib/modules/module-types";
import type { ModuleSearchItem, ModuleSearchSection } from "@/lib/search/module-search-types";
import type {
	PaletteCategory,
	PaletteCategoryId,
	PaletteGroup,
	PaletteIcon,
	PaletteItem,
	PaletteKeyEvent,
	PaletteMessageHit,
} from "./palette-types";
import type { CommandItem } from "./types";

const ALL_CATEGORY: PaletteCategory = { id: "all", label: "All", icon: Search };

const CORE_CATEGORIES: readonly PaletteCategory[] = [
	{ id: "pages", label: "Pages", icon: LayoutGrid },
	{ id: "messages", label: "Messages", icon: Mail },
	{ id: "contacts", label: "Contacts", icon: Users },
	{ id: "actions", label: "Actions", icon: Zap },
	{ id: "settings", label: "Settings", icon: Settings },
];

/** Categories the number keys 1 to 9 reach; later ones take the arrow keys or a click. */
export const NUMBERED_CATEGORIES = 9;

/**
 * The sidebar: All, the five core categories, then one per module that is on and has commands or
 * answers a search section, in registry order. A module with neither has nothing to show.
 */
export function listCategories(
	modules: readonly ClientModuleData[],
	enabled: readonly ModuleId[],
	commands: readonly CommandItem[],
	iconFor: (name: string) => LucideIcon,
): PaletteCategory[] {
	const withCommands = new Set(commands.map((command) => command.moduleId));
	const fromModules = modules
		.filter((module) => enabled.includes(module.id))
		.filter((module) => withCommands.has(module.id) || (module.searchSections?.length ?? 0) > 0)
		.map((module): PaletteCategory => ({
			id: `module:${module.id}`,
			label: module.name,
			icon: iconFor(module.nav[0]?.icon ?? ""),
			moduleId: module.id,
		}));
	return [ALL_CATEGORY, ...CORE_CATEGORIES, ...fromModules];
}

const CORE_PLACEMENT: Record<string, { category: PaletteItem["category"]; type: string }> = {
	Navigation: { category: "pages", type: "PAGE" },
	Settings: { category: "settings", type: "SETTING" },
};

/**
 * Where a command sits: a module's commands under the module, core's by group (Navigation, Settings, else Actions).
 * @public Tested on its own.
 */
export function commandPlacement(command: Pick<CommandItem, "moduleId" | "category" | "effect">): {
	category: PaletteItem["category"];
	type: string;
} {
	if (command.moduleId && command.moduleId !== "core") {
		return {
			category: `module:${command.moduleId as ModuleId}`,
			type: command.effect === "navigate" ? "PAGE" : "ACTION",
		};
	}
	return CORE_PLACEMENT[command.category] ?? { category: "actions", type: "ACTION" };
}

export function commandItems(commands: readonly CommandItem[]): PaletteItem[] {
	return commands.map((command): PaletteItem => {
		const { category, type } = commandPlacement(command);
		return {
			id: `command:${command.id}`,
			category,
			type,
			title: command.title,
			subtitle: command.subtitle,
			icon: command.icon,
			shortcut: command.shortcut,
			params: command.params,
			perform: command.perform,
		};
	});
}

/** The pages route commands open, so a Settings page a command already names is listed once. */
export function commandHrefs(commands: readonly CommandItem[]): Set<string> {
	return new Set(commands.flatMap((command) => (command.href ? [command.href] : [])));
}

/** Settings and Admin pages the user may open, as "Settings · Account" rows; pages a command names are skipped. */
export function settingsItems(
	groups: readonly NavSearchGroup[],
	taken: ReadonlySet<string>,
	navigate: (href: string) => void,
): PaletteItem[] {
	return groups.flatMap((group) =>
		group.sections.flatMap((section) =>
			section.items
				.filter((item) => !taken.has(item.href))
				.map((item): PaletteItem => ({
					id: `nav:${item.href}`,
					category: "settings",
					type: "SETTING",
					title: item.label,
					subtitle: [navModeLabels[group.mode], section.label || section.ariaLabel].filter(Boolean).join(" · "),
					icon: item.icon,
					perform: () => navigate(item.href),
				})),
		),
	);
}

/** Folder pages that open a message by id; every other status opens in the inbox. */
const MESSAGE_FOLDERS: Record<string, string> = {
	sent: "sent",
	queued: "sent",
	failed: "sent",
	draft: "drafts",
	spam: "spam",
	trash: "trash",
	archived: "archived",
};

/** @public Tested on its own. */
export function messageHref(status: string, id: string): string {
	return `/${MESSAGE_FOLDERS[status] ?? "inbox"}/${encodeURIComponent(id)}`;
}

/**
 * The other party of a message: its sender, or "To <recipients>" for mail the user sent.
 * @public Tested on its own.
 */
export function messageParty(message: PaletteMessageHit): string {
	if (message.direction === "outbound") return `To ${formatRecipientSummary(message.toAddr, message.toContactName)}`;
	return message.fromContactName ?? (message.fromAddr ? getEmailDisplayName(message.fromAddr) : "Unknown sender");
}

export function messageItem(
	message: PaletteMessageHit,
	navigate: (href: string) => void,
	formatDate: (iso: string) => string,
): PaletteItem {
	return {
		id: `message:${message.id}`,
		category: "messages",
		type: "MESSAGE",
		title: message.subject?.trim() || "(No subject)",
		subtitle: `${messageParty(message)} · ${formatDate(message.createdAt)}`,
		icon: Mail,
		perform: () => navigate(messageHref(message.status, message.id)),
	};
}

export function contactItem(contact: ContactSearchHit, open: (email: string) => void): PaletteItem {
	const name = contact.displayName?.trim();
	return {
		id: `contact:${contact.email}`,
		category: "contacts",
		type: "CONTACT",
		title: name || contact.email,
		subtitle: [name ? contact.email : "Search mail from this address", contact.blocked ? "Blocked" : null]
			.filter(Boolean)
			.join(" · "),
		icon: Users,
		perform: () => open(contact.email),
	};
}

/**
 * The type badge of a module record: `calendar:event` reads EVENT, `finance:subscription` SUBSCRIPTION.
 * @public Tested on its own.
 */
export function refKindType(kind: string): string {
	const type = kind.includes(":") ? kind.slice(kind.indexOf(":") + 1) : kind;
	return type.replace(/_/g, " ").toUpperCase();
}

export function sectionItems(
	section: ModuleSearchSection,
	icon: PaletteIcon | undefined,
	navigate: (href: string) => void,
): PaletteItem[] {
	return section.items.map((item: ModuleSearchItem): PaletteItem => ({
		id: `${item.ref.kind}:${item.ref.id}`,
		category: `module:${section.moduleId as ModuleId}`,
		type: refKindType(item.ref.kind),
		title: item.label,
		subtitle: item.sublabel || section.label,
		icon,
		perform: () => navigate(item.href),
	}));
}

/**
 * How many results each category has: the listed rows, or the search's own total where it reported more
 * than it listed. All counts every row.
 */
export function countItems(
	items: readonly PaletteItem[],
	categories: readonly PaletteCategory[],
	totals: Partial<Record<PaletteCategoryId, number | undefined>> = {},
): Record<string, number> {
	const counts: Record<string, number> = {};
	for (const category of categories) counts[category.id] = 0;
	for (const item of items) counts[item.category] = (counts[item.category] ?? 0) + 1;
	for (const [id, total] of Object.entries(totals)) {
		if (typeof total === "number") counts[id] = Math.max(counts[id] ?? 0, total);
	}
	counts.all = categories.filter((category) => category.id !== "all").reduce((sum, c) => sum + (counts[c.id] ?? 0), 0);
	return counts;
}

/** The rows under their headings, in sidebar order; one group when a category is chosen. Empty groups are left out. */
export function groupItems(
	items: readonly PaletteItem[],
	categories: readonly PaletteCategory[],
	active: PaletteCategoryId,
): PaletteGroup[] {
	return categories
		.filter((category) => category.id !== "all" && (active === "all" || category.id === active))
		.map((category) => ({ category, items: items.filter((item) => item.category === category.id) }))
		.filter((group) => group.items.length > 0);
}

/** The highlighted row after a key: the arrows wrap at both ends, Home and End jump. -1 when there is nothing. */
export function moveActive(current: number, count: number, key: string): number {
	if (count === 0) return -1;
	const at = Math.min(Math.max(current, 0), count - 1);
	switch (key) {
		case "ArrowDown":
			return (at + 1) % count;
		case "ArrowUp":
			return (at - 1 + count) % count;
		case "Home":
			return 0;
		case "End":
			return count - 1;
		default:
			return at;
	}
}

/** 1 to 9 for a digit key (by code, so Alt on a Mac keyboard still reads as the digit), else null. */
export function digitOf(event: Pick<PaletteKeyEvent, "code" | "ctrlKey" | "metaKey">): number | null {
	const match = /^(?:Digit|Numpad)([1-9])$/.exec(event.code);
	if (!match || event.ctrlKey || event.metaKey) return null;
	return Number(match[1]);
}

/** The category a digit chooses, when there is one that far down the sidebar. */
export function categoryForDigit(categories: readonly PaletteCategory[], digit: number): PaletteCategoryId | null {
	if (digit < 1 || digit > NUMBERED_CATEGORIES) return null;
	return categories[digit - 1]?.id ?? null;
}

/** The neighbouring category for an arrow key on the sidebar, wrapping at both ends. */
export function adjacentCategory(
	categories: readonly PaletteCategory[],
	active: PaletteCategoryId,
	key: string,
): PaletteCategoryId {
	const index = Math.max(
		categories.findIndex((category) => category.id === active),
		0,
	);
	const forward = key === "ArrowDown" || key === "ArrowRight";
	const backward = key === "ArrowUp" || key === "ArrowLeft";
	if (key === "Home") return categories[0]?.id ?? active;
	if (key === "End") return categories[categories.length - 1]?.id ?? active;
	if (!forward && !backward) return active;
	const next = (index + (forward ? 1 : -1) + categories.length) % categories.length;
	return categories[next]?.id ?? active;
}

const KEY_LABELS: Record<string, string> = { escape: "Esc", enter: "↵", arrowdown: "↓", arrowup: "↑", " ": "Space" };

/** A shortcut as the keys to draw as chips: "g i" is two, "?" one; letters are shown in upper case. */
export function shortcutKeys(shortcut: string): string[] {
	return shortcut
		.split(" ")
		.filter(Boolean)
		.map((key) => KEY_LABELS[key.toLowerCase()] ?? (key.length === 1 ? key.toUpperCase() : key));
}

/** A key that would type a character, so it belongs in the search box wherever focus is. */
export function isTypingKey(event: Pick<PaletteKeyEvent, "key" | "ctrlKey" | "metaKey" | "altKey">): boolean {
	return event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey;
}

/** A still-valid highlight after the rows changed: the same index when it exists, else the last row or none. */
export function clampActive(active: number, count: number): number {
	if (count === 0) return -1;
	return Math.min(Math.max(active, 0), count - 1);
}

/** What an empty list says: an invitation to type for the searched categories, else that nothing matched. */
export function emptyMessage(query: string, category: PaletteCategoryId, loading: boolean): string {
	if (query) return loading ? "Searching…" : `No matching results for “${query}”`;
	if (category === "messages") return "Type to search your mail";
	if (category === "contacts") return "Type a name or an address";
	if (category.startsWith("module:")) return "Type to search here";
	return "Nothing to show";
}
