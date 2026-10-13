import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { z } from "zod";
import { bundleModules, root } from "./support/modules-bundle.mjs";

const modulesDir = join(root, "src", "lib", "modules");
const {
	MODULE_MANIFESTS,
	MODULE_IDS,
	isModuleId,
	getModuleManifest,
	MODULE_CAPABILITIES,
	listCapabilities,
	findDescriptor,
	SERVER_MODULES,
	isInvokableDescriptor,
	surfacesAreCombinable,
	toJsonSchema,
} = await bundleModules("kite-module-registry-", [
	["MODULE_MANIFESTS, MODULE_IDS, isModuleId, getModuleManifest", "src/lib/modules/registry.ts"],
	["MODULE_CAPABILITIES, listCapabilities, findDescriptor", "src/lib/modules/capability-registry.ts"],
	["SERVER_MODULES", "src/lib/modules/server-registry.ts"],
	["isInvokableDescriptor, surfacesAreCombinable", "src/lib/modules/capability-utils.ts"],
	["toJsonSchema", "src/lib/modules/schema-utils.ts"],
]);

const IDS = ["calendar", "booking", "templates", "import"];
const CORE_QUEUE_KINDS = [
	"email.scheduled",
	"agent.draft",
	"agent.triage",
	"mailbox.purge",
	"backup.run",
	"webhook.retry",
];
const covers = (prefix, path) => path === prefix || path.startsWith(`${prefix}/`);
const allPrefixes = (key) =>
	MODULE_MANIFESTS.flatMap((manifest) => manifest[key].map((item) => ({ moduleId: manifest.id, ...item })));

test("the registry lists the four builtin modules in a fixed order", () => {
	assert.deepEqual(MODULE_IDS, IDS);
	assert.deepEqual(
		MODULE_CAPABILITIES.map((entry) => entry.moduleId),
		IDS,
	);
	assert.deepEqual(Object.keys(SERVER_MODULES), IDS);
	assert.equal(new Set(MODULE_IDS).size, MODULE_IDS.length);
	for (const manifest of MODULE_MANIFESTS) assert.equal(manifest.runtime, "builtin");
	assert.equal(isModuleId("calendar"), true);
	assert.equal(isModuleId("mail"), false);
	assert.equal(isModuleId(undefined), false);
	assert.equal(getModuleManifest("booking").name, "Booking");
	assert.throws(() => getModuleManifest("nope"), /Unknown module/);
});

test("dependencies are known and acyclic, and every builtin module is on by default", () => {
	assert.deepEqual(getModuleManifest("booking").dependsOn, ["calendar"]);
	const visit = (id, trail) => {
		assert.ok(!trail.includes(id), `cycle through ${[...trail, id].join(" -> ")}`);
		for (const dep of getModuleManifest(id).dependsOn) {
			assert.ok(isModuleId(dep), `${id} depends on unknown ${dep}`);
			visit(dep, [...trail, id]);
		}
	};
	for (const id of IDS) visit(id, []);
	for (const manifest of MODULE_MANIFESTS) assert.equal(manifest.defaultEnabled, true);
});

test("page and API prefixes never overlap and never cover export", () => {
	for (const key of ["pages", "apiPrefixes"]) {
		const entries = allPrefixes(key);
		for (const [index, a] of entries.entries())
			for (const b of entries.slice(index + 1))
				assert.ok(!covers(a.prefix, b.prefix) && !covers(b.prefix, a.prefix), `${a.prefix} overlaps ${b.prefix}`);
	}
	for (const { prefix } of allPrefixes("pages")) assert.ok(!covers(prefix, "/settings/export"), prefix);
	for (const { prefix } of allPrefixes("apiPrefixes")) assert.ok(!covers(prefix, "/api/export/messages"), prefix);
	assert.deepEqual(
		allPrefixes("apiPrefixes")
			.filter((item) => item.public)
			.map((item) => item.prefix),
		["/api/public/booking"],
	);
});

test("manifests carry what the spec lists for each module", () => {
	const calendar = getModuleManifest("calendar");
	assert.deepEqual(
		calendar.mcpScopes.map((scope) => [scope.scope, scope.mailboxBound]),
		[
			["mcp:calendar-read", false],
			["mcp:calendar-write", false],
		],
	);
	assert.deepEqual(
		calendar.apiKeyScopes.map((scope) => scope.scope),
		["calendar:read", "calendar:write"],
	);
	assert.deepEqual(
		calendar.webhookEvents.map((event) => event.value),
		["calendar.event.created", "calendar.event.updated", "calendar.event.deleted"],
	);
	assert.deepEqual(calendar.searchSections, [{ id: "events", label: "Events" }]);
	assert.deepEqual(
		getModuleManifest("booking").webhookEvents.map((event) => event.value),
		["booking.appointment.created"],
	);
	assert.deepEqual(getModuleManifest("templates").messageStatuses, ["template"]);
	assert.deepEqual(
		getModuleManifest("templates").composerSlots.map((slot) => slot.id),
		["templates.send-menu"],
	);
	const importManifest = getModuleManifest("import");
	assert.deepEqual(importManifest.queueMessageTypes, [
		{ kind: "import.imap", queue: "agent", capability: "processImportJob", metricClass: "import" },
	]);
	assert.deepEqual(importManifest.cronTasks, [
		{ name: "resumeStalledImports", schedule: "every_tick", capability: "resumeStalledImports" },
	]);
	assert.ok(importManifest.adminNotes?.[0].includes("resume within about five minutes"));
	for (const manifest of MODULE_MANIFESTS) assert.deepEqual(manifest.jmapCapabilities, []);
	const accountMenu = MODULE_MANIFESTS.flatMap((manifest) => manifest.nav).filter(
		(item) => item.placement === "account-menu",
	);
	assert.deepEqual(
		accountMenu.map((item) => [item.label, item.href]),
		[["Booking", "/booking"]],
	);
});

test("commands use their own module id and valid targets", () => {
	const ids = new Set();
	for (const manifest of MODULE_MANIFESTS)
		for (const command of manifest.commands) {
			assert.equal(command.moduleId, manifest.id);
			assert.ok(command.id.startsWith(`${manifest.id}.`), command.id);
			assert.ok(!ids.has(command.id), `duplicate command ${command.id}`);
			ids.add(command.id);
			if (command.target.type === "route") assert.ok(command.target.href.startsWith("/"));
			else assert.ok(command.target.handler);
		}
	assert.deepEqual([...ids].sort(), [
		"booking.copy_link",
		"booking.open",
		"booking.open_event_type",
		"calendar.go_to_date",
		"calendar.new_event",
		"calendar.open",
		"import.open",
	]);
});

test("manifests import nothing server-only, no zod and no React", () => {
	const forbidden =
		/from\s+["'](@\/db|@\/lib\/cloudflare|server-only|zod|react|react-dom|next|\.\.?\/(?:.*\/)?(?:schemas|server|capabilities))/;
	for (const id of [...IDS.map((name) => `${name}/manifest.ts`), "registry.ts", "module-types.d.ts"]) {
		const source = readFileSync(join(modulesDir, id), "utf8");
		for (const line of source.split("\n").filter((text) => /^\s*(import|export)\b.*\bfrom\b/.test(text)))
			assert.ok(!forbidden.test(line), `${id} must stay client-safe: ${line}`);
	}
});

test("every module directory has the full set of files", () => {
	for (const id of IDS)
		assert.deepEqual(readdirSync(join(modulesDir, id)).sort(), [
			"capabilities.ts",
			"manifest.ts",
			"schemas.ts",
			"server.ts",
		]);
});

test("descriptor lists survive a JSON round trip and prompt fragments are static strings", () => {
	for (const entry of MODULE_CAPABILITIES) {
		assert.deepEqual(JSON.parse(JSON.stringify(entry.descriptors)), entry.descriptors, entry.moduleId);
		assert.ok(entry.promptFragment === null || typeof entry.promptFragment === "string");
		for (const descriptor of entry.descriptors)
			assert.equal(Object.getPrototypeOf(descriptor), Object.prototype, descriptor.name);
	}
	const placeholders = MODULE_CAPABILITIES.flatMap((entry) => entry.promptFragment?.match(/\{[^}]*\}/g) ?? []);
	assert.ok(
		placeholders.every((value) => ["{timeZone}", "{today}"].includes(value)),
		placeholders.join(),
	);
});

test("descriptor names are unique per module and surfaces are valid", () => {
	for (const entry of MODULE_CAPABILITIES) {
		const names = entry.descriptors.map((descriptor) => descriptor.name);
		assert.equal(new Set(names).size, names.length, `${entry.moduleId} repeats a descriptor name`);
		for (const descriptor of entry.descriptors) {
			assert.ok(surfacesAreCombinable(descriptor.surfaces), `${entry.moduleId}.${descriptor.name} surfaces`);
			assert.ok(descriptor.description.length > 0);
		}
	}
	assert.equal(surfacesAreCombinable(["assistant_tool", "mcp_tool"]), true);
	assert.equal(surfacesAreCombinable(["assistant_tool", "search"]), false);
	assert.equal(surfacesAreCombinable([]), false);
	assert.equal(surfacesAreCombinable(["search", "search"]), false);
});

test("every invokable descriptor has a handler and every handler a descriptor", () => {
	for (const entry of MODULE_CAPABILITIES) {
		const server = SERVER_MODULES[entry.moduleId];
		const invokable = entry.descriptors.filter(isInvokableDescriptor).map((descriptor) => descriptor.name);
		assert.deepEqual(Object.keys(server.handlers).sort(), [...invokable].sort(), entry.moduleId);
		for (const descriptor of entry.descriptors)
			assert.ok(server.schemas[descriptor.name], `${descriptor.name} has no schema`);
		assert.deepEqual(Object.keys(server.schemas).sort(), entry.descriptors.map((descriptor) => descriptor.name).sort());
	}
});

test("every inputSchema and outputSchema equals z.toJSONSchema of its zod schema", () => {
	let checked = 0;
	for (const entry of MODULE_CAPABILITIES)
		for (const descriptor of entry.descriptors) {
			const schemas = SERVER_MODULES[entry.moduleId].schemas[descriptor.name];
			assert.deepEqual(descriptor.inputSchema, z.toJSONSchema(schemas.input, { io: "input" }), descriptor.name);
			assert.deepEqual(descriptor.inputSchema, toJsonSchema(schemas.input, "input"));
			if (schemas.output) assert.deepEqual(descriptor.outputSchema, z.toJSONSchema(schemas.output, { io: "output" }));
			else assert.equal(descriptor.outputSchema, undefined);
			checked++;
		}
	assert.ok(checked >= 25);
});

test("scopes are grants the module declares", () => {
	for (const entry of MODULE_CAPABILITIES) {
		const grants = getModuleManifest(entry.moduleId).grants.map((item) => item.grant);
		for (const descriptor of entry.descriptors)
			for (const scope of descriptor.scopes ?? []) assert.ok(grants.includes(scope), `${descriptor.name}: ${scope}`);
	}
	for (const manifest of MODULE_MANIFESTS)
		for (const entry of [...manifest.mcpScopes, ...manifest.apiKeyScopes])
			for (const grant of entry.grants)
				assert.ok(
					manifest.grants.some((item) => item.grant === grant),
					grant,
				);
});

test("queue and cron declarations match their descriptors both ways", () => {
	const kinds = new Set();
	for (const manifest of MODULE_MANIFESTS) {
		const descriptors = MODULE_CAPABILITIES.find((entry) => entry.moduleId === manifest.id).descriptors;
		for (const entry of manifest.queueMessageTypes) {
			const descriptor = descriptors.find((item) => item.name === entry.capability);
			assert.ok(descriptor?.surfaces.includes("queue"), `${entry.kind} names no queue descriptor`);
			assert.equal(descriptor.queue.kind, entry.kind);
			assert.ok(!kinds.has(entry.kind), `duplicate queue kind ${entry.kind}`);
			assert.ok(!CORE_QUEUE_KINDS.includes(entry.kind), `${entry.kind} collides with a core kind`);
			kinds.add(entry.kind);
		}
		for (const entry of manifest.cronTasks) {
			const descriptor = descriptors.find((item) => item.name === entry.capability);
			assert.ok(descriptor?.surfaces.includes("cron"), `${entry.name} names no cron descriptor`);
			assert.equal(descriptor.cron.task, entry.name);
		}
		for (const descriptor of descriptors.filter((item) => item.surfaces.includes("queue")))
			assert.ok(
				manifest.queueMessageTypes.some((entry) => entry.kind === descriptor.queue.kind),
				descriptor.name,
			);
		for (const descriptor of descriptors.filter((item) => item.surfaces.includes("cron")))
			assert.ok(
				manifest.cronTasks.some((entry) => entry.name === descriptor.cron.task),
				descriptor.name,
			);
	}
	const long = MODULE_CAPABILITIES.find((entry) => entry.moduleId === "import").descriptors.filter(
		(descriptor) => descriptor.surfaces.includes("queue") || descriptor.surfaces.includes("cron"),
	);
	for (const descriptor of long) assert.ok(descriptor.timeoutMs > 5 * 60_000 && descriptor.timeoutMs < 8 * 60_000);
});

test("actions name existing suggestion kinds and every action type and reason has a label", () => {
	for (const entry of MODULE_CAPABILITIES) {
		const manifest = getModuleManifest(entry.moduleId);
		const kinds = entry.descriptors.filter((item) => item.suggestionKind).map((item) => item.suggestionKind.kind);
		for (const descriptor of entry.descriptors.filter((item) => item.action)) {
			if (descriptor.action.suggestionKind)
				assert.ok(kinds.includes(descriptor.action.suggestionKind), descriptor.name);
			assert.ok(manifest.actionLabels[descriptor.action.actionType], `no label for ${descriptor.action.actionType}`);
		}
		for (const descriptor of entry.descriptors.filter((item) => item.suggestionKind))
			assert.ok(manifest.reasonTexts[descriptor.suggestionKind.reasonTemplate], descriptor.name);
		assert.ok(manifest.reasonTexts[`module_disabled:${manifest.id}`], `${manifest.id} has no module_disabled text`);
		for (const descriptor of entry.descriptors.filter((item) => item.event))
			assert.ok(
				manifest.webhookEvents.some((event) => event.value === descriptor.event.value),
				descriptor.name,
			);
		for (const event of manifest.webhookEvents)
			assert.ok(
				entry.descriptors.some((item) => item.event?.value === event.value),
				event.value,
			);
		for (const descriptor of entry.descriptors.filter((item) => item.search))
			assert.ok(
				manifest.searchSections.some((section) => section.id === descriptor.search.section),
				descriptor.name,
			);
		for (const descriptor of entry.descriptors.filter((item) => item.refs))
			for (const kind of descriptor.refs.kinds)
				assert.ok(
					manifest.recordKinds.some((item) => item.kind === kind),
					kind,
				);
	}
});

test("lifecycle hooks follow the data-hook rule", () => {
	const hook = (id, name) => findDescriptor(id, name).lifecycle;
	assert.deepEqual(hook("calendar", "timeZoneChanged"), { event: "user.time_zone_changed", dataHook: true });
	assert.deepEqual(hook("booking", "userCreated"), { event: "user.created", dataHook: false });
});

test("listCapabilities returns the enabled modules' descriptors for a surface in registry order", () => {
	const names = (surface, enabled) => listCapabilities(surface, enabled).map((item) => item.descriptor.name);
	assert.equal(names("assistant_tool", IDS).length, 8);
	assert.deepEqual(names("assistant_tool", ["booking", "templates", "import"]), []);
	assert.deepEqual(names("mcp_tool", ["calendar"]), names("assistant_tool", ["calendar"]));
	assert.deepEqual(names("search", ["calendar"]), ["search"]);
	assert.deepEqual(names("search", ["booking"]), []);
	assert.deepEqual(names("webhook_event", IDS), ["eventCreated", "eventUpdated", "eventDeleted", "appointmentCreated"]);
	assert.deepEqual(names("webhook_event", ["booking", "calendar"]), [
		"eventCreated",
		"eventUpdated",
		"eventDeleted",
		"appointmentCreated",
	]);
	assert.deepEqual(names("webhook_event", ["booking"]), ["appointmentCreated"]);
	assert.deepEqual(names("jmap_method", IDS), []);
	assert.deepEqual(names("cron", ["import"]), ["resumeStalledImports"]);
});

test("registry sources use static imports only, with no dynamic loading", () => {
	const registry = readFileSync(join(modulesDir, "registry.ts"), "utf8");
	const server = readFileSync(join(modulesDir, "server-registry.ts"), "utf8");
	for (const id of IDS) {
		assert.ok(registry.includes(`from "./${id}/manifest"`), `${id} manifest import`);
		assert.ok(server.includes(`from "./${id}/server"`), `${id} server import`);
	}
	const forbidden = /\beval\(|new Function|\bimport\(|isNodeRuntime|KITE_RUNTIME/;
	const walk = (dir) =>
		readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
			entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)],
		);
	for (const file of walk(modulesDir))
		assert.ok(!forbidden.test(readFileSync(file, "utf8")), `${file} loads code dynamically`);
});
