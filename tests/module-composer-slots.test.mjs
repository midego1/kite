import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { bundleModules, root } from "./support/modules-bundle.mjs";

const {
	MODULE_MANIFESTS,
	moduleOwnedMessageStatuses,
	CLIENT_MODULES,
	listComposerSlots,
	listMessageSlots,
	slotsToLoad,
	messageStatusExclusions,
} = await bundleModules("kite-module-composer-slots-", [
	["MODULE_MANIFESTS, moduleOwnedMessageStatuses", "src/lib/modules/registry.ts"],
	["CLIENT_MODULES", "src/lib/modules/client-data/index.ts"],
	["listComposerSlots, listMessageSlots, slotsToLoad", "src/lib/modules/composer-slot-utils.ts"],
	["messageStatusExclusions", "src/lib/modules/message-status-utils.ts"],
]);

const read = (path) => readFileSync(join(root, path), "utf8");
const ALL = ["calendar", "booking", "templates", "import", "finance", "drive"];

const withSlots = [
	{ id: "calendar", composerSlots: [{ id: "calendar.late", slot: "send-menu", order: 50, label: "Late" }] },
	{ id: "templates", composerSlots: [{ id: "templates.send-menu", slot: "send-menu", order: 10, label: "Template" }] },
	{ id: "import" },
];

test("the slot helper lists only enabled modules' send-menu slots, in order", () => {
	assert.deepEqual(
		listComposerSlots(withSlots, ["calendar", "templates", "import"], "send-menu").map((slot) => slot.id),
		["templates.send-menu", "calendar.late"],
	);
	assert.deepEqual(
		listComposerSlots(withSlots, ["calendar", "import"], "send-menu").map((slot) => slot.id),
		["calendar.late"],
	);
	assert.equal(listComposerSlots(withSlots, ["templates"], "send-menu")[0].moduleId, "templates");
});

test("slot chunks are requested only once the menu has been opened", () => {
	const slots = listComposerSlots(withSlots, ["calendar", "templates"], "send-menu");
	assert.deepEqual(slotsToLoad(slots, false), []);
	assert.deepEqual(
		slotsToLoad(slots, true).map((slot) => slot.id),
		["templates.send-menu", "calendar.late"],
	);
	assert.deepEqual(slotsToLoad([], true), []);
});

test("ties keep module order and a slot for another placement is not listed", () => {
	const modules = [
		{ id: "calendar", composerSlots: [{ id: "a", slot: "send-menu", order: 5, label: "A" }] },
		{ id: "booking", composerSlots: [{ id: "b", slot: "send-menu", order: 5, label: "B" }] },
		{ id: "templates", composerSlots: [{ id: "c", slot: "toolbar", order: 1, label: "C" }] },
	];
	assert.deepEqual(
		listComposerSlots(modules, ALL, "send-menu").map((slot) => slot.id),
		["a", "b"],
	);
});

test("with Templates off the real registry reports no slots, so the menu has no separator", () => {
	assert.deepEqual(listComposerSlots(CLIENT_MODULES, ["calendar", "booking", "import"], "send-menu"), []);
	assert.deepEqual(
		listComposerSlots(MODULE_MANIFESTS, ALL, "send-menu").map((slot) => slot.id),
		["templates.send-menu"],
	);
	assert.deepEqual(
		listComposerSlots(CLIENT_MODULES, ALL, "send-menu").map((slot) => slot.id),
		["templates.send-menu"],
	);
	assert.deepEqual(listComposerSlots(CLIENT_MODULES, [], "send-menu"), []);
});

test("the client slice and the manifest declare the same slots", () => {
	for (const manifest of MODULE_MANIFESTS) {
		const slice = CLIENT_MODULES.find((item) => item.id === manifest.id);
		assert.deepEqual(slice?.composerSlots ?? [], manifest.composerSlots, manifest.id);
	}
});

test("every status a module owns is excluded from ordinary lists", () => {
	assert.deepEqual(moduleOwnedMessageStatuses(), ["template"]);
	for (const requested of [null, "received", "sent", "draft", "spam", "trash", "archived"]) {
		for (const enabled of [ALL, ["calendar", "booking", "import"], []])
			assert.deepEqual(messageStatusExclusions(MODULE_MANIFESTS, requested, enabled), ["template"], String(requested));
	}
});

test("status=template lists rows only while Templates is on for the viewer", () => {
	const rows = [{ status: "received" }, { status: "template" }, { status: "draft" }];
	const list = (requested, enabled) => {
		const excluded = messageStatusExclusions(MODULE_MANIFESTS, requested, enabled);
		return rows.filter((row) => (!requested || row.status === requested) && !excluded.includes(row.status));
	};
	assert.deepEqual(messageStatusExclusions(MODULE_MANIFESTS, "template", ALL), []);
	assert.deepEqual(list("template", ALL), [{ status: "template" }]);
	assert.deepEqual(list("template", ["calendar", "booking", "import"]), []);
	assert.deepEqual(list(null, ALL), [{ status: "received" }, { status: "draft" }]);
	assert.deepEqual(list(null, []), [{ status: "received" }, { status: "draft" }]);
});

test("the module registry loads the templates client lazily with the server-render guard", () => {
	const registry = read("src/components/modules/client-registry.ts");
	assert.match(
		registry,
		/templates:\s*\(\)\s*=>\s*\(typeof window === "undefined" \? new Promise<never>\(\(\) => \{\}\) : import\("\.\/templates\/client"\)/,
	);
	assert.doesNotMatch(registry, /^import .*\/templates\//m);
});

test("the send menu reaches template code only through the composer slot", () => {
	const menu = read("src/components/compose/schedule-send-menu.tsx");
	assert.match(menu, /useComposerSlots\("send-menu"/);
	assert.doesNotMatch(menu, /template/i);
	for (const moved of ["template-menu", "new-template-dialog", "template-types"]) {
		assert.ok(!existsSync(join(root, "src/components/compose", `${moved}.tsx`)), moved);
		assert.ok(!existsSync(join(root, "src/components/compose", `${moved}.d.ts`)), moved);
	}
	for (const file of ["template-menu.tsx", "new-template-dialog.tsx", "client.ts"])
		assert.ok(existsSync(join(root, "src/components/modules/templates", file)), file);
});

test("composer and message menu slots share one lazy chunk loader, and the reader menu names no module", () => {
	for (const file of [
		"src/components/compose/composer-slot.tsx",
		"src/components/message-actions/message-menu-slots.tsx",
	]) {
		const source = read(file);
		assert.match(source, /useSlotEntries\(/, file);
		assert.doesNotMatch(source, /loadModuleClient|import\(/, file);
	}
	assert.match(read("src/components/modules/use-slot-entries.ts"), /loadModuleClient\(slot\.moduleId\)/);
	const menu = read("src/components/message-actions/message-actions.tsx");
	assert.match(menu, /useMessageMenuSlots\(\{ messageId, mailboxId \}/);
	assert.doesNotMatch(menu, /finance|calendar|templates|booking/i);
	assert.deepEqual(listMessageSlots(CLIENT_MODULES, [], "message-menu"), [], "nothing on, no entries");
});

test("the message list route excludes owned statuses through the registry helper", () => {
	const route = read("src/app/api/messages/route.ts");
	assert.match(route, /ownedStatusCondition\(/);
	assert.doesNotMatch(route, /"template"/);
	assert.match(read("src/lib/modules/message-status.ts"), /messageStatusExclusions\(MODULE_MANIFESTS/);
});
