import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = makeBundleDirectory("kite-section-nav-test-");
after(() => rmSync(outDir, { recursive: true, force: true }));

await build({
	entryPoints: [join(root, "src/components/settings/section-nav-utils.ts")],
	outfile: join(outDir, "entry.mjs"),
	bundle: true,
	sourcemap: "inline",
	platform: "node",
	format: "esm",
	target: "node22",
	tsconfig: join(root, "tsconfig.json"),
	logLevel: "silent",
});

const {
	canShowModeSwitch,
	filterNavSections,
	findActiveNavItem,
	getNavMode,
	isActiveNavPath,
	navSectionLabel,
	navSectionsFor,
	searchNavAcrossModes,
	switchTarget,
} = await import(pathToFileURL(join(outDir, "entry.mjs")).href);
const settingsNavSections = navSectionsFor("settings");
const adminNavSections = navSectionsFor("admin");
const canSee = (item, user) => filterNavSections([{ label: "", items: [item] }], "", user).length === 1;

const base = { isPrimaryAdmin: false, canManageDomains: false, canManageUsers: false };
const primary = { ...base, role: "admin", isPrimaryAdmin: true };
const admin = { ...base, role: "admin" };
const member = { ...base, role: "user" };

const hrefs = (sections) => sections.flatMap((section) => section.items.map((item) => item.href));
const searchHrefs = (query, user, mode = "settings") =>
	Object.fromEntries(searchNavAcrossModes(query, user, mode).map((group) => [group.mode, hrefs(group.sections)]));

test("Settings holds the Account, Mail, Integrations and Data groups, and no admin page", () => {
	assert.deepEqual(
		settingsNavSections.map((section) => section.label),
		["Account", "Mail", "Integrations", "Data"],
	);
	assert.deepEqual(hrefs(settingsNavSections.slice(0, 3)), [
		"/settings/account",
		"/settings/appearance",
		"/settings/security",
		"/settings/inbox",
		"/settings/composing",
		"/settings/notifications",
		"/settings/rules",
		"/settings/mailboxes",
		"/settings/connected-accounts",
		"/settings/app-passwords",
		"/settings/api-keys",
	]);
	for (const href of hrefs(settingsNavSections)) assert.match(href, /^\/settings\//);
});

test("Admin groups its pages by task, with AI usage and no separate Audit logs", () => {
	assert.deepEqual(
		adminNavSections.map((section) => section.label),
		["", "People", "Mail", "AI", "Modules", "Data", "System"],
	);
	assert.deepEqual(hrefs(adminNavSections), [
		"/admin",
		"/accounts",
		"/activity",
		"/domains",
		"/mailboxes",
		"/routing",
		"/agent",
		"/ai-usage",
		"/modules",
		"/drive/settings",
		"/backups",
		"/storage",
		"/general",
		"/branding",
		"/alerts",
		"/api-keys",
		"/webhooks",
	]);
	for (const item of adminNavSections.flatMap((section) => section.items)) assert.ok(item.permission, item.href);
});

test("getNavMode treats admin routes and their children as admin", () => {
	for (const path of ["/admin", "/admin/x", "/domains", "/accounts/abc/permissions", "/mailboxes/mbx_1", "/ai-usage"])
		assert.equal(getNavMode(path), "admin", path);
	for (const path of ["/settings/account", "/settings/api-keys", "/administrator", "/domainsx", "/inbox"])
		assert.equal(getNavMode(path), "settings", path);
});

test("the active rule matches exact paths and children only", () => {
	assert.equal(isActiveNavPath("/admin", "/admin"), true);
	assert.equal(isActiveNavPath("/admin/x", "/admin"), true);
	assert.equal(isActiveNavPath("/accounts", "/admin"), false);
	assert.equal(isActiveNavPath("/administrator", "/admin"), false);
	assert.equal(findActiveNavItem("admin", "/accounts/abc")?.href, "/accounts");
	assert.equal(findActiveNavItem("admin", "/domains")?.href, "/domains");
	assert.equal(findActiveNavItem("settings", "/settings/security")?.label, "Security");
});

test("switchTarget opens the first page of the other mode", () => {
	assert.equal(switchTarget("settings", primary), "/admin");
	assert.equal(switchTarget("settings", admin), "/admin");
	assert.equal(switchTarget("admin", primary), "/settings/account");
	assert.equal(switchTarget("admin", member), "/settings/account");
});

test("only admins get the mode switch", () => {
	assert.equal(canShowModeSwitch(primary), true);
	assert.equal(canShowModeSwitch(admin), true);
	assert.equal(canShowModeSwitch(member), false);
	assert.equal(canShowModeSwitch(null), false);
});

test("permission gates follow role, primary admin and per-user grants", () => {
	const visible = (user) => hrefs(filterNavSections(adminNavSections, "", user));
	assert.equal(visible(primary).length, 17);
	assert.ok(visible(primary).includes("/alerts"));
	assert.ok(visible(primary).includes("/storage"));
	// Domain routing applies to every address on a domain, so it follows the domain grant like Domains does.
	assert.deepEqual(visible(admin), ["/admin", "/accounts", "/mailboxes", "/drive/settings"]);
	assert.deepEqual(visible({ ...admin, canManageDomains: true }), [
		"/admin",
		"/accounts",
		"/domains",
		"/mailboxes",
		"/routing",
		"/drive/settings",
	]);
	assert.deepEqual(visible(member), []);
	assert.deepEqual(visible(null), []);
	assert.equal(canSee({ href: "/x", label: "X", permission: "users" }, { ...admin, canManageUsers: true }), true);
	assert.equal(canSee({ href: "/x", label: "X", permission: "users" }, admin), false);
	assert.equal(canSee({ href: "/x", label: "X" }, member), true);
});

test("search finds pages of both modes, current mode first", () => {
	assert.deepEqual(searchHrefs("domains", primary), { admin: ["/domains"] });
	assert.deepEqual(searchHrefs("appearance", primary, "admin"), { settings: ["/settings/appearance"] });
	assert.deepEqual(
		searchNavAcrossModes("api keys", primary, "admin").map((group) => group.mode),
		["admin", "settings"],
	);
	assert.deepEqual(searchHrefs("zzzz", primary), {});
});

test("old Workspace names stay searchable", () => {
	assert.deepEqual(searchHrefs("members", primary), { admin: ["/accounts"] });
	assert.deepEqual(searchHrefs("shared inboxes", primary), { admin: ["/mailboxes"] });
	assert.ok(searchHrefs("workspace", primary).admin.includes("/branding"));
});

test("audit searches find Activity, which /audit-logs redirects to", () => {
	for (const query of ["audit", "audit logs", "audit log"]) {
		assert.deepEqual(searchHrefs(query, primary), { admin: ["/activity"] }, query);
		assert.deepEqual(searchHrefs(query, primary, "admin"), { admin: ["/activity"] }, query);
	}
	assert.equal(findActiveNavItem("admin", "/activity")?.label, "Activity");
});

test("search never returns items the user cannot see", () => {
	assert.deepEqual(searchHrefs("domains", member), {});
	assert.deepEqual(searchHrefs("backups", member), {});
	assert.deepEqual(searchHrefs("members", member), {});
	for (const query of ["backups", "branding", "webhooks", "audit", "ai usage", "agent", "activity", "alerts"])
		assert.equal(searchHrefs(query, admin).admin, undefined, query);
	assert.deepEqual(searchHrefs("domains", admin), {});
	assert.deepEqual(searchHrefs("members", admin), { admin: ["/accounts"] });
});

test("Backups and Storage form the Data group, with the old System name still searchable", () => {
	const data = adminNavSections.find((section) => section.label === "Data");
	assert.deepEqual(hrefs([data]), ["/backups", "/storage"]);
	const bySystem = searchHrefs("system", primary, "admin").admin;
	for (const href of ["/activity", "/backups", "/storage", "/general"]) assert.ok(bySystem.includes(href), href);
});

test("Alerts sits in System after Branding, before the integration keys, for the primary admin only", () => {
	const administration = adminNavSections.find((section) => section.label === "System");
	const items = administration.items.map((item) => item.href);
	assert.deepEqual(items, ["/general", "/branding", "/alerts", "/api-keys", "/webhooks"]);
	const alerts = administration.items.find((item) => item.href === "/alerts");
	assert.equal(alerts.label, "Alerts");
	assert.equal(alerts.permission, "primary");
	assert.equal(canSee(alerts, primary), true);
	assert.equal(canSee(alerts, admin), false);
	assert.equal(canSee(alerts, member), false);
	assert.equal(findActiveNavItem("admin", "/alerts")?.label, "Alerts");
	assert.equal(getNavMode("/alerts"), "admin");
	for (const query of ["alerts", "slack", "ntfy"]) {
		assert.deepEqual(searchHrefs(query, primary), { admin: ["/alerts"] }, query);
		assert.deepEqual(searchHrefs(query, primary, "admin"), { admin: ["/alerts"] }, query);
		assert.deepEqual(searchHrefs(query, admin), {}, query);
		assert.deepEqual(searchHrefs(query, admin, "admin"), {}, query);
		assert.deepEqual(searchHrefs(query, member), {}, query);
	}
});

test("Modules heads its own group, before the module settings pages, for the primary admin only", () => {
	const group = adminNavSections.find((section) => section.label === "Modules");
	assert.deepEqual(hrefs([group]), ["/modules", "/drive/settings"]);
	const modules = group.items[0];
	assert.equal(modules.label, "Modules");
	assert.equal(modules.permission, "primary");
	assert.equal(canSee(modules, primary), true);
	assert.equal(canSee(modules, admin), false);
	assert.equal(canSee(modules, member), false);
	assert.equal(getNavMode("/modules"), "admin");
	assert.equal(findActiveNavItem("admin", "/modules")?.label, "Modules");
	assert.deepEqual(searchHrefs("modules", primary), { admin: ["/modules", "/drive/settings"] });
	assert.deepEqual(searchHrefs("people access", primary), { admin: ["/accounts", "/modules"] });
	assert.deepEqual(searchHrefs("modules", member), {});
	assert.deepEqual(searchHrefs("modules", admin), { admin: ["/drive/settings"] });
});

test("group landmarks always have a name", () => {
	const [overview, people] = adminNavSections;
	assert.equal(navSectionLabel("admin", overview, false), "Admin overview");
	assert.equal(navSectionLabel("admin", overview, true), "Admin");
	assert.equal(navSectionLabel("admin", people, true), "Admin: People");
	assert.equal(navSectionLabel("settings", settingsNavSections[0], false), "Account");
});
