import {
	Activity,
	BellRing,
	Bot,
	DatabaseBackup,
	Download,
	Gauge,
	Globe2,
	Inbox,
	KeyRound,
	LayoutDashboard,
	Lock,
	Mail,
	Palette,
	Route,
	Settings,
	Shield,
	Upload,
	User,
	Users,
	Webhook,
} from "lucide-react";
import type { AuthMeUser } from "@/lib/auth/me-client-types";
import type { NavItem, NavMode, NavSearchGroup, NavSection } from "./section-nav-types";

const settingsNavSections: NavSection[] = [
	{
		label: "Personal",
		items: [
			{
				href: "/settings/account",
				label: "My account",
				icon: User,
				keywords: "profile name photo avatar time zone language",
			},
			{
				href: "/settings/appearance",
				label: "Appearance",
				icon: Palette,
				keywords: "theme dark light style font text size kite classic",
			},
			{
				href: "/settings/inbox",
				label: "Inbox",
				icon: Inbox,
				keywords: "threading conversation notifications shortcuts sending undo images spam trash auto reply",
			},
			{ href: "/settings/security", label: "Security", icon: Shield, keywords: "password two-factor mfa totp" },
			{ href: "/settings/rules", label: "Rules & routing", icon: Route, keywords: "filters automations" },
			{ href: "/settings/api-keys", label: "API keys", icon: KeyRound, keywords: "token mcp jmap" },
			{ href: "/settings/app-passwords", label: "App passwords", icon: Lock, keywords: "imap smtp client" },
		],
	},
	{
		label: "Mailbox",
		items: [
			{ href: "/settings/import", label: "Import", icon: Download, keywords: "imap migrate" },
			{ href: "/settings/export", label: "Export", icon: Upload, keywords: "backup download" },
		],
	},
];

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
				keywords: "admin dashboard database migrations general workspace",
				permission: "admin",
			},
		],
	},
	{
		label: "Email",
		items: [
			{
				href: "/mailboxes",
				label: "Mailboxes",
				icon: Mail,
				keywords: "shared inboxes aliases workspace",
				permission: "admin",
			},
			{ href: "/domains", label: "Domains", icon: Globe2, keywords: "dns workspace", permission: "domains" },
			{
				href: "/routing",
				label: "Routing",
				icon: Route,
				keywords: "catch-all forward reject rules",
				permission: "admin",
			},
			{ href: "/webhooks", label: "Webhooks", icon: Webhook, keywords: "events deliveries", permission: "primary" },
		],
	},
	{
		label: "Administration",
		items: [
			{ href: "/api-keys", label: "API keys", icon: KeyRound, keywords: "token mcp jmap", permission: "primary" },
			{ href: "/general", label: "General", icon: Settings, keywords: "workspace instance", permission: "primary" },
			{ href: "/agent", label: "Agent", icon: Bot, keywords: "assistant ai model", permission: "primary" },
			{
				href: "/accounts",
				label: "Accounts",
				icon: Users,
				keywords: "members roles users permissions workspace",
				permission: "admin",
			},
			{
				href: "/activity",
				label: "Activity",
				icon: Activity,
				// /audit-logs redirects here, so its names are searchable keywords instead of a separate item.
				keywords: "log events audit audit logs audit log history security",
				permission: "primary",
			},
			{ href: "/backups", label: "Backups", icon: DatabaseBackup, keywords: "restore export", permission: "primary" },
			{
				href: "/alerts",
				label: "Alerts",
				icon: BellRing,
				keywords: "webhook notifications slack discord ntfy",
				permission: "primary",
			},
			{ href: "/ai-usage", label: "AI usage", icon: Gauge, keywords: "tokens cost assistant", permission: "primary" },
		],
	},
	{
		label: "Product",
		items: [
			{
				href: "/branding",
				label: "Branding",
				icon: Palette,
				keywords: "name logo icon workspace",
				permission: "primary",
			},
		],
	},
];

const sectionsByMode: Record<NavMode, NavSection[]> = { settings: settingsNavSections, admin: adminNavSections };

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
	const isAdmin = adminNavSections.some((section) =>
		section.items.some((item) => isActiveNavPath(pathname, item.href)),
	);
	return isAdmin ? "admin" : "settings";
}

export function findActiveNavItem(mode: NavMode, pathname: string): NavItem | undefined {
	return navSectionsFor(mode)
		.flatMap((section) => section.items)
		.find((item) => isActiveNavPath(pathname, item.href));
}

function canSeeNavItem(item: NavItem, user: AuthMeUser | null): boolean {
	if (!item.permission) return true;
	if (!user || user.role !== "admin") return false;
	if (item.permission === "primary") return user.isPrimaryAdmin;
	if (item.permission === "domains") return user.isPrimaryAdmin || user.canManageDomains;
	if (item.permission === "users") return user.isPrimaryAdmin || user.canManageUsers;
	return true;
}

export function filterNavSections(sections: NavSection[], query: string, user: AuthMeUser | null): NavSection[] {
	const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
	return sections
		.map((section) => ({
			...section,
			items: section.items.filter((item) => {
				if (!canSeeNavItem(item, user)) return false;
				const haystack = `${item.label} ${item.keywords ?? ""} ${section.label}`.toLowerCase();
				return terms.every((term) => haystack.includes(term));
			}),
		}))
		.filter((section) => section.items.length > 0);
}

/** Matches from both modes, the current mode first; groups with no visible match are left out. */
export function searchNavAcrossModes(query: string, user: AuthMeUser | null, currentMode: NavMode): NavSearchGroup[] {
	return [currentMode, otherNavMode(currentMode)]
		.map((mode) => ({ mode, sections: filterNavSections(navSectionsFor(mode), query, user) }))
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
