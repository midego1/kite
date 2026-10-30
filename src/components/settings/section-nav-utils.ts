import {
	Activity,
	Bell,
	BellRing,
	Blocks,
	Bot,
	DatabaseBackup,
	Gauge,
	Globe2,
	HardDrive,
	Inbox,
	KeyRound,
	Link2,
	LayoutDashboard,
	Lock,
	Mail,
	Palette,
	PenLine,
	Route,
	Settings,
	Shield,
	Upload,
	User,
	Users,
	Webhook,
} from "lucide-react";
import { resolveNavIcon } from "@/components/modules/client-registry";
import type { AuthMeUser } from "@/lib/auth/me-client-types";
import { moduleNavItems } from "@/lib/modules/nav-utils";
import type { ModuleId } from "@/lib/modules/module-types";
import { CLIENT_MODULES } from "@/lib/modules/client-data";
import type { NavItem, NavMode, NavSearchGroup, NavSection } from "./section-nav-types";

// The Settings and Admin menu and the page are separate rounded panels on the page background, like the inbox's
// list and reader; on phones the menu is a sheet and the page fills the screen.
export const SECTION_PANEL_CLASS = "md:rounded-xl md:border md:border-neutral-200 md:bg-white md:shadow-xs";

/** Core items sit among a module's by this order; Export stays after Import, and module settings after Modules. */
const EXPORT_ORDER = 20;

const settingsNavSections: NavSection[] = [
	{
		label: "Account",
		items: [
			{
				href: "/settings/account",
				label: "My account",
				icon: User,
				keywords: "profile name photo avatar time zone language recovery forwarding",
			},
			{
				href: "/settings/appearance",
				label: "Appearance",
				icon: Palette,
				keywords: "theme dark light style font text size kite classic assistant dyslexia opendyslexic accessibility",
			},
			{ href: "/settings/security", label: "Security", icon: Shield, keywords: "password two-factor mfa totp" },
		],
	},
	{
		label: "Mail",
		items: [
			{
				href: "/settings/inbox",
				label: "Inbox",
				icon: Inbox,
				keywords:
					"threading conversation layout shortcuts images screener new senders approve deny spam trash clean-up",
			},
			{
				href: "/settings/composing",
				label: "Composing",
				icon: PenLine,
				keywords: "sending undo send preview signature auto reply out of office vacation",
			},
			{
				href: "/settings/notifications",
				label: "Notifications",
				icon: Bell,
				keywords: "browser notifications one-time codes new mail",
			},
			{ href: "/settings/rules", label: "Rules & routing", icon: Route, keywords: "filters automations" },
			{
				href: "/settings/mailboxes",
				label: "Mailboxes",
				icon: Mail,
				keywords: "addresses aliases display name",
				permission: "mailboxes",
			},
		],
	},
	{
		label: "Integrations",
		items: [
			{
				href: "/settings/connected-accounts",
				label: "Connected accounts",
				icon: Link2,
				keywords: "gmail icloud outlook yahoo fastmail imap external account app password",
			},
			{ href: "/settings/app-passwords", label: "App passwords", icon: Lock, keywords: "imap smtp jmap client" },
			{ href: "/settings/api-keys", label: "API keys", icon: KeyRound, keywords: "token mcp jmap" },
		],
	},
	{
		label: "Data",
		items: [{ href: "/settings/export", label: "Export", icon: Upload, keywords: "backup download mbox" }],
	},
];

/**
 * Adds the items the modules declare for a menu to their groups, in manifest order among the core ones.
 * Admin menu items always carry the admin permission, so searching from Settings never shows one to a member.
 */
function withModuleItems(sections: NavSection[], placement: "settings-nav" | "admin-nav"): NavSection[] {
	const items = moduleNavItems(CLIENT_MODULES, placement);
	return sections.map((section) => {
		const added = items.filter((item) => item.group === section.label);
		if (!added.length) return section;
		const core = section.items.map((item) => ({ item, order: item.order ?? EXPORT_ORDER }));
		const fromModules = added.map((entry) => ({
			order: entry.order,
			item: {
				href: entry.href,
				label: entry.label,
				icon: resolveNavIcon(entry.icon),
				keywords: entry.keywords?.join(" "),
				moduleId: entry.moduleId,
				...(placement === "admin-nav" ? { permission: "admin" as const } : {}),
			} satisfies NavItem,
		}));
		return { ...section, items: [...fromModules, ...core].sort((a, b) => a.order - b.order).map(({ item }) => item) };
	});
}

// Every admin item carries a permission so that searching from Settings never shows one to a member.
const adminNavSections: NavSection[] = [
	{
		label: "",
		ariaLabel: "Admin overview",
		items: [
			{
				href: "/admin",
				label: "Overview",
				icon: LayoutDashboard,
				keywords: "admin dashboard database migrations general workspace status health",
				permission: "admin",
			},
		],
	},
	{
		label: "People",
		items: [
			{
				href: "/accounts",
				label: "Accounts",
				icon: Users,
				keywords: "members roles users permissions workspace people access",
				permission: "admin",
			},
			{
				href: "/activity",
				label: "Activity",
				icon: Activity,
				// /audit-logs redirects here, so its names are searchable keywords instead of a separate item.
				keywords: "log events audit audit logs audit log history security sign-ins system",
				permission: "primary",
			},
		],
	},
	{
		label: "Mail",
		items: [
			{ href: "/domains", label: "Domains", icon: Globe2, keywords: "dns workspace email", permission: "domains" },
			{
				href: "/mailboxes",
				label: "Mailboxes",
				icon: Mail,
				keywords: "shared inboxes aliases workspace email",
				permission: "admin",
			},
			{
				href: "/routing",
				label: "Routing",
				icon: Route,
				keywords: "catch-all forward reject rules email",
				permission: "domains",
			},
		],
	},
	{
		label: "AI",
		items: [
			{ href: "/agent", label: "Agent", icon: Bot, keywords: "assistant ai model provider", permission: "primary" },
			{ href: "/ai-usage", label: "AI usage", icon: Gauge, keywords: "tokens cost assistant", permission: "primary" },
		],
	},
	{
		label: "Modules",
		items: [
			{
				href: "/modules",
				label: "Modules",
				icon: Blocks,
				keywords: "calendar booking templates import turn on off features people access",
				permission: "primary",
				order: 0,
			},
		],
	},
	{
		label: "Data",
		items: [
			{
				href: "/backups",
				label: "Backups",
				icon: DatabaseBackup,
				keywords: "restore export database system",
				permission: "primary",
			},
			{
				href: "/storage",
				label: "Storage",
				icon: HardDrive,
				keywords: "s3 r2 bucket minio backblaze wasabi object storage migrate cors system",
				permission: "primary",
			},
		],
	},
	{
		label: "System",
		items: [
			{ href: "/general", label: "General", icon: Settings, keywords: "workspace instance", permission: "primary" },
			{
				href: "/branding",
				label: "Branding",
				icon: Palette,
				keywords: "name logo icon workspace product",
				permission: "primary",
			},
			{
				href: "/alerts",
				label: "Alerts",
				icon: BellRing,
				keywords: "webhook notifications slack discord ntfy",
				permission: "primary",
			},
			{
				href: "/api-keys",
				label: "API keys",
				icon: KeyRound,
				keywords: "token mcp jmap integrations",
				permission: "primary",
			},
			{
				href: "/webhooks",
				label: "Webhooks",
				icon: Webhook,
				keywords: "events deliveries integrations",
				permission: "primary",
			},
		],
	},
];

const sectionsByMode: Record<NavMode, NavSection[]> = {
	settings: withModuleItems(settingsNavSections, "settings-nav"),
	admin: withModuleItems(adminNavSections, "admin-nav"),
};

export const navModeLabels: Record<NavMode, string> = { settings: "Settings", admin: "Admin" };

export function navSectionsFor(mode: NavMode): NavSection[] {
	return sectionsByMode[mode];
}

function otherNavMode(mode: NavMode): NavMode {
	return mode === "admin" ? "settings" : "admin";
}

export function isActiveNavPath(pathname: string, href: string): boolean {
	return pathname === href || pathname.startsWith(`${href}/`);
}

export function getNavMode(pathname: string): NavMode {
	const isAdmin = sectionsByMode.admin.some((section) =>
		section.items.some((item) => isActiveNavPath(pathname, item.href)),
	);
	return isAdmin ? "admin" : "settings";
}

export function findActiveNavItem(mode: NavMode, pathname: string): NavItem | undefined {
	return navSectionsFor(mode)
		.flatMap((section) => section.items)
		.find((item) => isActiveNavPath(pathname, item.href));
}

/** The menu group holding the current page, for the page panel's trail. */
export function findActiveNavSection(mode: NavMode, pathname: string): NavSection | undefined {
	return navSectionsFor(mode).find((section) => section.items.some((item) => isActiveNavPath(pathname, item.href)));
}

function canSeeNavItem(item: NavItem, user: AuthMeUser | null, modules?: readonly ModuleId[]): boolean {
	if (item.moduleId && modules && !modules.includes(item.moduleId)) return false;
	if (!item.permission) return true;
	if (item.permission === "mailboxes") return user?.canManageMailboxes === true;
	if (!user || user.role !== "admin") return false;
	if (item.permission === "primary") return user.isPrimaryAdmin;
	if (item.permission === "domains") return user.isPrimaryAdmin || user.canManageDomains;
	if (item.permission === "users") return user.isPrimaryAdmin || user.canManageUsers;
	return true;
}

/** `modules` is what the user has on; omitted, every module's items are listed. */
export function filterNavSections(
	sections: NavSection[],
	query: string,
	user: AuthMeUser | null,
	modules?: readonly ModuleId[],
): NavSection[] {
	const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
	return sections
		.map((section) => ({
			...section,
			items: section.items.filter((item) => {
				if (!canSeeNavItem(item, user, modules)) return false;
				const haystack = `${item.label} ${item.keywords ?? ""} ${section.label}`.toLowerCase();
				return terms.every((term) => haystack.includes(term));
			}),
		}))
		.filter((section) => section.items.length > 0);
}

/** Matches from both modes, the current mode first; groups with no visible match are left out. */
export function searchNavAcrossModes(
	query: string,
	user: AuthMeUser | null,
	currentMode: NavMode,
	modules?: readonly ModuleId[],
): NavSearchGroup[] {
	return [currentMode, otherNavMode(currentMode)]
		.map((mode) => ({ mode, sections: filterNavSections(navSectionsFor(mode), query, user, modules) }))
		.filter((group) => group.sections.length > 0);
}

export function canShowModeSwitch(user: AuthMeUser | null): boolean {
	return user?.role === "admin";
}

/** The first page of a mode that the user may open. */
export function navModeHome(mode: NavMode, user: AuthMeUser | null): string {
	const items = navSectionsFor(mode).flatMap((section) => section.items);
	return (items.find((item) => canSeeNavItem(item, user)) ?? items[0]).href;
}

export function switchTarget(mode: NavMode, user: AuthMeUser | null): string {
	return navModeHome(otherNavMode(mode), user);
}

/** The landmark name of a group; `withMode` prefixes the mode for search results from the other mode. */
export function navSectionLabel(mode: NavMode, section: NavSection, withMode: boolean): string {
	if (!withMode) return section.label || section.ariaLabel || navModeLabels[mode];
	return section.label ? `${navModeLabels[mode]}: ${section.label}` : navModeLabels[mode];
}
