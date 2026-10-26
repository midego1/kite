import type { CoreShortcut, UiCommand } from "./module-types";

function navigate(
	id: string,
	label: string,
	href: string,
	extra: Partial<Pick<UiCommand, "description" | "keywords" | "shortcut" | "group">> = {},
): UiCommand {
	return {
		id,
		moduleId: "core",
		label,
		description: extra.description ?? `Open ${label.replace(/^Go to /, "")}`,
		group: "Navigation",
		target: { type: "route", href },
		effect: "navigate",
		...extra,
	};
}

/**
 * The commands core owns. Ids, labels and shortcuts of the first block are the ones the palette had
 * before commands moved out of the shortcuts provider, so saved habits and docs keep working.
 */
export const CORE_COMMANDS: readonly UiCommand[] = [
	{
		id: "compose",
		moduleId: "core",
		label: "Compose new message",
		description: "Open draft editor",
		keywords: ["Compose Email", "new email", "write"],
		group: "Actions",
		target: { type: "client", action: "open_dialog", handler: "openComposer" },
		effect: "fill",
		shortcut: "c",
	},
	navigate("nav-inbox", "Go to Inbox", "/inbox", { shortcut: "g i" }),
	navigate("nav-starred", "Go to Starred", "/starred", { shortcut: "g s" }),
	navigate("nav-snoozed", "Go to Snoozed", "/snoozed", { shortcut: "g z" }),
	navigate("nav-sent", "Go to Sent", "/sent", { shortcut: "g t" }),
	navigate("nav-drafts", "Go to Drafts", "/drafts", { shortcut: "g d" }),
	navigate("nav-archived", "Go to Archived", "/archived", { shortcut: "g a" }),
	navigate("nav-spam", "Go to Spam", "/spam", { shortcut: "g !" }),
	navigate("nav-trash", "Go to Trash", "/trash", { shortcut: "g x" }),
	{
		id: "all-mailboxes",
		moduleId: "core",
		label: "Show all mailboxes",
		description: "Read every mailbox you can open in one Inbox",
		keywords: ["unified", "combined", "all inboxes"],
		group: "Navigation",
		target: { type: "client", action: "apply_filter", handler: "showAllMailboxes" },
		effect: "navigate",
	},
	{
		id: "one-mailbox",
		moduleId: "core",
		label: "Show one mailbox",
		description: "Leave All mailboxes for the mailbox chosen last",
		keywords: ["unified", "combined", "single mailbox"],
		group: "Navigation",
		target: { type: "client", action: "apply_filter", handler: "showOneMailbox" },
		effect: "navigate",
	},
	{
		...navigate("settings-account", "Account Settings", "/settings/account", {
			description: "Profile, password & preferences",
		}),
		group: "Settings",
	},
	{
		id: "show-help",
		moduleId: "core",
		label: "Keyboard Shortcuts Cheat Sheet",
		description: "View all quick keys",
		group: "General",
		target: { type: "client", action: "open_view", handler: "showShortcutsHelp" },
		effect: "read",
		shortcut: "?",
	},
	navigate("nav-for-you", "Go to For you", "/for-you", {
		description: "Suggestions Kite prepared for you",
		keywords: ["suggestions", "assistant"],
	}),
	navigate("nav-activity", "Go to Activity", "/kite-activity", {
		description: "What the assistant did on your mailboxes",
		keywords: ["log", "assistant", "history"],
	}),
	{ ...navigate("nav-settings", "Go to Settings", "/settings"), group: "Settings" },
	navigate("mail.export", "Export mail", "/settings/export", {
		description: "Download a mailbox as an mbox file",
		keywords: ["download", "backup", "mbox"],
	}),
];

/** The key bindings core owns, in the order the cheat sheet lists them. */
export const CORE_SHORTCUTS: readonly CoreShortcut[] = [
	{ key: "k", modifiers: ["meta", "ctrl"], label: "Command Palette", category: "General", chrome: "togglePalette" },
	{ key: "?", label: "Shortcuts Cheat Sheet", category: "General", chrome: "toggleHelp" },
	{ key: "c", label: "Compose Email", category: "Composing", commandId: "compose" },
	{ key: "/", label: "Search Mail", category: "Navigation", chrome: "focusSearch" },
	{ key: "g i", label: "Go to Inbox", category: "Navigation", commandId: "nav-inbox" },
	{ key: "g s", label: "Go to Starred", category: "Navigation", commandId: "nav-starred" },
	{ key: "g z", label: "Go to Snoozed", category: "Navigation", commandId: "nav-snoozed" },
	{ key: "g t", label: "Go to Sent", category: "Navigation", commandId: "nav-sent" },
	{ key: "g d", label: "Go to Drafts", category: "Navigation", commandId: "nav-drafts" },
	{ key: "g a", label: "Go to Archived", category: "Navigation", commandId: "nav-archived" },
	{ key: "g !", label: "Go to Spam", category: "Navigation", commandId: "nav-spam" },
	{ key: "g x", label: "Go to Trash", category: "Navigation", commandId: "nav-trash" },
	{ key: "escape", label: "Dismiss Modal / Clear Focus", category: "General", chrome: "dismiss" },
];
