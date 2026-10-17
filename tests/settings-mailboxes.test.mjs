import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const directory = makeBundleDirectory("kite-settings-mailboxes-test-");
after(() => rmSync(directory, { recursive: true, force: true }));
await build({
	stdin: {
		contents: `
			export { canManageOwnMailboxes, getMailboxesBase, listedMailboxes, mailboxIdParam } from "./src/app/(admin)/mailboxes/utils.ts";
			export { filterNavSections, findActiveNavItem, getNavMode, navSectionsFor, searchNavAcrossModes } from "./src/components/settings/section-nav-utils.ts";
		`,
		resolveDir: root,
		sourcefile: "settings-mailboxes-test-entry.ts",
	},
	outfile: join(directory, "entry.mjs"),
	bundle: true,
	sourcemap: "inline",
	absWorkingDir: root,
	platform: "node",
	format: "esm",
	target: "node24",
	tsconfig: join(root, "tsconfig.json"),
	logLevel: "silent",
});
const m = await import(pathToFileURL(join(directory, "entry.mjs")).href);

const base = { isPrimaryAdmin: false, canManageDomains: false, canManageUsers: false, canManageMailboxes: false };
const member = { ...base, role: "user" };
const mailboxMember = { ...member, canManageMailboxes: true };
const admin = { ...base, role: "admin" };
const settingsHrefs = (user) =>
	m
		.filterNavSections(m.navSectionsFor("settings"), "", user)
		.flatMap((section) => section.items.map((item) => item.href));

test("Settings lists Mailboxes only for users with the mailbox grant", () => {
	assert.ok(settingsHrefs(mailboxMember).includes("/settings/mailboxes"));
	assert.ok(settingsHrefs({ ...admin, canManageMailboxes: true }).includes("/settings/mailboxes"));
	for (const user of [member, admin, null]) assert.ok(!settingsHrefs(user).includes("/settings/mailboxes"));
	const mailboxGroup = m.navSectionsFor("settings").find((section) => section.label === "Mailbox");
	assert.ok(mailboxGroup.items.some((item) => item.href === "/settings/mailboxes" && item.label === "Mailboxes"));
});

test("Settings → Mailboxes and its editor stay in Settings, and search finds it only for the grant", () => {
	assert.equal(m.getNavMode("/settings/mailboxes"), "settings");
	assert.equal(m.getNavMode("/settings/mailboxes/mbx_1"), "settings");
	assert.equal(m.findActiveNavItem("settings", "/settings/mailboxes/mbx_1")?.href, "/settings/mailboxes");
	const found = (user) =>
		m
			.searchNavAcrossModes("aliases", user, "settings")
			.flatMap((group) => group.sections.flatMap((section) => section.items.map((item) => item.href)));
	assert.deepEqual(found(mailboxMember), ["/settings/mailboxes"]);
	assert.deepEqual(found(member), []);
});

test("the mailbox pages link within the area they were opened from", () => {
	assert.equal(m.getMailboxesBase("/settings/mailboxes"), "/settings/mailboxes");
	assert.equal(m.getMailboxesBase("/settings/mailboxes/mbx_1"), "/settings/mailboxes");
	assert.equal(m.getMailboxesBase("/mailboxes"), "/mailboxes");
	assert.equal(m.getMailboxesBase("/mailboxes/mbx_1"), "/mailboxes");
	assert.equal(m.getMailboxesBase("/settings/mailboxesx"), "/mailboxes");
	assert.equal(m.getMailboxesBase(null), "/mailboxes");
	assert.equal(m.mailboxIdParam("mbx_1"), "mbx_1");
	assert.equal(m.mailboxIdParam(["mbx_1"]), "mbx_1");
	assert.equal(m.mailboxIdParam([]), "");
	assert.equal(m.mailboxIdParam(undefined), "");
});

test("Settings lists only the user's own mailboxes; Admin lists all it can open", () => {
	const rows = [
		{ id: "mine", userId: "u1" },
		{ id: "shared", userId: "owner" },
	];
	assert.deepEqual(m.listedMailboxes(rows, "/mailboxes", "u1"), rows);
	assert.deepEqual(
		m.listedMailboxes(rows, "/settings/mailboxes", "u1").map((row) => row.id),
		["mine"],
	);
	assert.deepEqual(m.listedMailboxes(rows, "/settings/mailboxes", undefined), []);
});

test("Settings → Mailboxes opens for the mailbox grant and for admins only", () => {
	assert.equal(m.canManageOwnMailboxes(mailboxMember), true);
	assert.equal(m.canManageOwnMailboxes(admin), true);
	assert.equal(m.canManageOwnMailboxes(member), false);
	assert.equal(m.canManageOwnMailboxes(null), false);
	assert.equal(m.canManageOwnMailboxes(undefined), false);
});
