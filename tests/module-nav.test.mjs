import assert from "node:assert/strict";
import test from "node:test";
import { bundleModules } from "./support/modules-bundle.mjs";

const {
	moduleNavItems,
	MODULE_MANIFESTS,
	navSectionsFor,
	filterNavSections,
	searchNavAcrossModes,
	getNavMode,
	findActiveNavItem,
	resolveNavIcon,
} = await bundleModules("kite-module-nav-", [
	["moduleNavItems", "src/lib/modules/nav-utils.ts"],
	["MODULE_MANIFESTS", "src/lib/modules/registry.ts"],
	[
		"navSectionsFor, filterNavSections, searchNavAcrossModes, getNavMode, findActiveNavItem",
		"src/components/settings/section-nav-utils.ts",
	],
	["resolveNavIcon", "src/components/modules/client-registry.ts"],
]);

const ALL = ["calendar", "booking", "templates", "import", "finance", "drive"];
const labels = (items) => items.map((item) => item.label);
const hrefs = (sections) => sections.flatMap((section) => section.items.map((item) => item.href));
const member = { role: "user", isPrimaryAdmin: false, canManageDomains: false, canManageUsers: false };
const admin = { ...member, role: "admin" };

test("the mailbox selector shows Calendar and Drive and the account menu shows Booking while they are on", () => {
	assert.deepEqual(labels(moduleNavItems(MODULE_MANIFESTS, "mailbox-selector", ALL)), ["Calendar", "Drive"]);
	assert.deepEqual(labels(moduleNavItems(MODULE_MANIFESTS, "mailbox-selector", ["calendar"])), ["Calendar"]);
	assert.deepEqual(labels(moduleNavItems(MODULE_MANIFESTS, "account-menu", ALL)), ["Booking"]);
	assert.deepEqual(moduleNavItems(MODULE_MANIFESTS, "account-menu", ALL)[0].href, "/booking");
	assert.deepEqual(moduleNavItems(MODULE_MANIFESTS, "mailbox-selector", ["booking"]), []);
	assert.deepEqual(moduleNavItems(MODULE_MANIFESTS, "account-menu", ["calendar"]), []);
});

test("the sidebar lists Subscriptions with its count endpoint only while Money Watch is on, then Drive", () => {
	const sidebar = moduleNavItems(MODULE_MANIFESTS, "sidebar", ALL);
	assert.deepEqual(labels(sidebar), ["Subscriptions", "Drive"]);
	assert.equal(sidebar[1].href, "/drive");
	assert.equal(sidebar[1].moduleId, "drive");
	assert.equal(sidebar[0].href, "/finance");
	assert.equal(sidebar[0].moduleId, "finance");
	assert.deepEqual(sidebar[0].count, { endpoint: "/api/finance/badge" });
	assert.deepEqual(
		moduleNavItems(
			MODULE_MANIFESTS,
			"sidebar",
			ALL.filter((id) => id !== "finance" && id !== "drive"),
		),
		[],
	);
	assert.notEqual(resolveNavIcon("WalletCards"), resolveNavIcon("NoSuchIcon"));
	assert.notEqual(resolveNavIcon("HardDrive"), resolveNavIcon("NoSuchIcon"));
});

test("the calendar tabs list Bookings before Calendar and drop the one that is off", () => {
	assert.deepEqual(labels(moduleNavItems(MODULE_MANIFESTS, "module-tabs", ALL)), ["Bookings", "Calendar"]);
	assert.deepEqual(labels(moduleNavItems(MODULE_MANIFESTS, "module-tabs", ["calendar", "templates"])), ["Calendar"]);
	assert.deepEqual(moduleNavItems(MODULE_MANIFESTS, "module-tabs", []), []);
});

test("without a module list every module's items are listed", () => {
	assert.deepEqual(labels(moduleNavItems(MODULE_MANIFESTS, "module-tabs")), ["Bookings", "Calendar"]);
});

test("items are ordered by `order`, then by registry order", () => {
	const manifests = [
		{ id: "a", nav: [{ id: "a1", placement: "module-tabs", order: 5, label: "A" }] },
		{ id: "b", nav: [{ id: "b1", placement: "module-tabs", order: 5, label: "B" }] },
		{ id: "c", nav: [{ id: "c1", placement: "module-tabs", order: 1, label: "C" }] },
	];
	assert.deepEqual(labels(moduleNavItems(manifests, "module-tabs")), ["C", "A", "B"]);
});

test("client-registry resolves manifest icon names and falls back for an unknown one", () => {
	for (const manifest of MODULE_MANIFESTS)
		for (const item of manifest.nav) assert.notEqual(resolveNavIcon(item.icon), resolveNavIcon("NoSuchIcon"), item.id);
	assert.equal(resolveNavIcon("NoSuchIcon"), resolveNavIcon("AlsoMissing"));
});

test("Settings lists Import before Export, and hides Import, not Export, while Mail import is off", () => {
	const settings = navSectionsFor("settings");
	const mailbox = settings.find((section) => section.label === "Mailbox");
	assert.deepEqual(labels(mailbox.items), ["Mailboxes", "Import", "Export"]);
	assert.deepEqual(
		hrefs(filterNavSections(settings, "", member, ALL)).filter((href) => /import|export/.test(href)),
		["/settings/import", "/settings/export"],
	);
	const withoutImport = filterNavSections(settings, "", member, ["calendar", "booking", "templates"]);
	assert.deepEqual(
		hrefs(withoutImport).filter((href) => /import|export/.test(href)),
		["/settings/export"],
	);
	assert.deepEqual(hrefs(filterNavSections(settings, "", member)).includes("/settings/import"), true);
});

test("the menu search does not find Import while Mail import is off", () => {
	const found = (modules) =>
		searchNavAcrossModes("import", member, "settings", modules).flatMap((group) => hrefs(group.sections));
	assert.deepEqual(found(ALL), ["/settings/import"]);
	assert.deepEqual(found(["calendar"]), []);
	assert.deepEqual(
		searchNavAcrossModes("export", member, "settings", ["calendar"]).flatMap((group) => hrefs(group.sections)),
		["/settings/export"],
	);
});

test("an admin-nav item joins its Admin group for admins only, and only while its module is on", () => {
	assert.deepEqual(labels(moduleNavItems(MODULE_MANIFESTS, "admin-nav", ALL)), ["Drive"]);
	assert.deepEqual(moduleNavItems(MODULE_MANIFESTS, "admin-nav", ["calendar"]), []);
	const system = navSectionsFor("admin").find((section) => section.label === "System");
	const drive = system.items.find((item) => item.href === "/drive/settings");
	assert.equal(drive.permission, "admin");
	assert.equal(drive.moduleId, "drive");
	const forAdmin = filterNavSections(navSectionsFor("admin"), "", admin, ALL);
	assert.ok(hrefs(forAdmin).includes("/drive/settings"));
	assert.ok(!hrefs(filterNavSections(navSectionsFor("admin"), "", member, ALL)).includes("/drive/settings"));
	assert.ok(
		!hrefs(
			filterNavSections(
				navSectionsFor("admin"),
				"",
				admin,
				ALL.filter((id) => id !== "drive"),
			),
		).includes("/drive/settings"),
	);
	assert.equal(getNavMode("/drive/settings"), "admin");
	assert.equal(getNavMode("/drive"), "settings", "the Drive app itself is not an admin page");
	assert.equal(findActiveNavItem("admin", "/drive/settings")?.label, "Drive");
	const found = (user, modules) =>
		searchNavAcrossModes("quota", user, "settings", modules).flatMap((group) => hrefs(group.sections));
	assert.deepEqual(found(admin, ALL), ["/drive/settings"]);
	assert.deepEqual(found(member, ALL), []);
	assert.deepEqual(found(admin, ["calendar"]), []);
});
