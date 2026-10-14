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
	toModelExtensionSchema,
	CLIENT_MODULES,
} = await bundleModules("kite-module-registry-", [
	["MODULE_MANIFESTS, MODULE_IDS, isModuleId, getModuleManifest", "src/lib/modules/registry.ts"],
	["MODULE_CAPABILITIES, listCapabilities, findDescriptor", "src/lib/modules/capability-registry.ts"],
	["SERVER_MODULES", "src/lib/modules/server-registry.ts"],
	["isInvokableDescriptor, surfacesAreCombinable", "src/lib/modules/capability-utils.ts"],
	["toJsonSchema, toModelExtensionSchema", "src/lib/modules/schema-utils.ts"],
	["CLIENT_MODULES", "src/lib/modules/client-data/index.ts"],
]);

const IDS = ["calendar", "booking", "templates", "import", "finance"];
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

test("the registry lists the five builtin modules in a fixed order", () => {
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
	assert.equal(getModuleManifest("finance").name, "Money Watch");
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
	const finance = getModuleManifest("finance");
	assert.deepEqual(finance.dependsOn, []);
	assert.deepEqual(finance.pages, [{ prefix: "/finance" }]);
	assert.deepEqual(finance.apiPrefixes, [{ prefix: "/api/finance" }]);
	assert.deepEqual(
		finance.recordKinds.map((item) => item.kind),
		["finance:subscription"],
	);
	assert.deepEqual(
		finance.webhookEvents.map((event) => event.value),
		["finance.subscription.detected", "finance.subscription.renewal_due"],
	);
	assert.deepEqual(
		finance.grants.map((item) => item.grant),
		["finance.read", "finance.write"],
	);
	assert.deepEqual(finance.mcpScopes, [
		{ scope: "mcp:finance-read", label: "Read subscriptions", grants: ["finance.read"], mailboxBound: false },
	]);
	assert.deepEqual(finance.apiKeyScopes, []);
	assert.deepEqual(finance.cronTasks, [
		{ name: "remindRenewals", schedule: "*/5 * * * *", capability: "remindRenewals" },
	]);
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
		"finance.open",
		"import.open",
	]);
});

test("message slots sit in the message menu under their own module id and match the client slice", () => {
	const ids = new Set();
	for (const manifest of MODULE_MANIFESTS) {
		for (const slot of manifest.messageSlots ?? []) {
			assert.equal(slot.slot, "message-menu", slot.id);
			assert.ok(slot.id.startsWith(`${manifest.id}.`), slot.id);
			assert.ok(!ids.has(slot.id), `duplicate message slot ${slot.id}`);
			ids.add(slot.id);
			assert.ok(Number.isFinite(slot.order), slot.id);
			assert.ok(slot.label.trim().length > 0 && slot.label.length <= 40, slot.id);
		}
		const slice = CLIENT_MODULES.find((item) => item.id === manifest.id);
		assert.deepEqual(slice?.messageSlots ?? [], manifest.messageSlots ?? [], manifest.id);
	}
	for (const manifest of MODULE_MANIFESTS)
		for (const slot of manifest.composerSlots)
			assert.ok(!ids.has(slot.id), `${slot.id} is both a composer and a message slot`);
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

test("suggestion kinds carry client meta, and reopening actions belong to a kind of their own module", () => {
	for (const entry of MODULE_CAPABILITIES) {
		const client = CLIENT_MODULES.find((item) => item.id === entry.moduleId);
		const kinds = entry.descriptors.filter((item) => item.suggestionKind).map((item) => item.suggestionKind);
		for (const kind of kinds) {
			const meta = client?.suggestionKindMeta?.[kind.kind];
			assert.ok(meta?.label, `${kind.kind} has no client label`);
			assert.ok(meta.reason[kind.reasonTemplate], `${kind.kind} has no reason text for ${kind.reasonTemplate}`);
			if (meta.badgePriority !== undefined) assert.ok(Number.isFinite(meta.badgePriority), kind.kind);
		}
		for (const descriptor of entry.descriptors.filter((item) => item.action?.reopensSuggestion))
			assert.ok(
				kinds.some((kind) => kind.kind === descriptor.action.suggestionKind),
				`${descriptor.name} reopens a suggestion its module does not own`,
			);
	}
});

const MODEL_PROPERTY_TYPES = new Set(["string", "number", "integer", "boolean", "null"]);

/** A scalar or enum property, with no `$ref`, `default`, nesting or combinator. */
function assertScalarProperty(name, schema) {
	assert.equal(typeof schema, "object", name);
	for (const banned of ["$ref", "default", "properties", "items", "anyOf", "oneOf", "allOf"])
		assert.equal(Object.hasOwn(schema, banned), false, `${name} has ${banned}`);
	assert.ok(MODEL_PROPERTY_TYPES.has(schema.type), `${name} type ${schema.type}`);
	if (schema.enum) assert.ok(Array.isArray(schema.enum) && schema.enum.length > 0, name);
}

/** A flat property: scalar or enum, or a nullable one written as an `anyOf` with `{ type: "null" }`. */
function assertFlatProperty(name, schema) {
	if (!Object.hasOwn(schema, "anyOf")) return assertScalarProperty(name, schema);
	assert.equal(Object.keys(schema).length, 1, `${name} has keys next to anyOf`);
	assert.equal(schema.anyOf.length, 2, name);
	assert.ok(
		schema.anyOf.some((entry) => entry.type === "null" && Object.keys(entry).length === 1),
		`${name} anyOf is not nullable`,
	);
	for (const entry of schema.anyOf) assertScalarProperty(name, entry);
}

test("triage model extensions are small, closed, flat and static, and name a hint of their own module", () => {
	let found = 0;
	for (const entry of MODULE_CAPABILITIES)
		for (const descriptor of entry.descriptors) {
			const model = descriptor.triage?.model;
			if (!model) continue;
			found += 1;
			const label = `${entry.moduleId}.${descriptor.name}`;
			assert.ok(descriptor.surfaces.includes("triage_step"), `${label} declares a model extension off a triage step`);
			const { jsonSchema } = model;
			assert.equal(jsonSchema.type, "object", label);
			assert.equal(jsonSchema.additionalProperties, false, label);
			assert.ok(JSON.stringify(jsonSchema).length <= 2048, `${label} schema is over 2 KB`);
			assert.equal(JSON.stringify(jsonSchema).includes('"$ref"'), false, label);
			assert.equal(Object.hasOwn(jsonSchema, "default"), false, label);
			for (const [name, property] of Object.entries(jsonSchema.properties ?? {}))
				assertFlatProperty(`${label}.${name}`, property);
			assert.equal(typeof model.instructions, "string", label);
			assert.ok(model.instructions.length > 0 && model.instructions.length <= 600, `${label} instructions length`);
			assert.match(model.instructions, /^[\x20-\x7e]+$/, `${label} instructions are printable on one line`);
			assert.equal(model.instructions.includes("<<<"), false, label);
			assert.doesNotMatch(model.instructions, /nonce\s*=/i, label);
			assert.ok(Number.isInteger(model.maxOutputTokens), label);
			assert.ok(model.maxOutputTokens >= 1 && model.maxOutputTokens <= 200, `${label} maxOutputTokens`);
			if (model.wantsModel !== undefined) {
				const hint = entry.descriptors.find((item) => item.name === model.wantsModel);
				assert.ok(hint?.surfaces.includes("service"), `${label} wantsModel must be a service of ${entry.moduleId}`);
			}
		}
	assert.ok(found >= 1, "Money Watch declares an extension");
	const detect = findDescriptor("finance", "detect").triage.model;
	assert.equal(detect.maxOutputTokens, 200);
	assert.equal(detect.wantsModel, "wantsModel");
	assert.equal(detect.instructions.length, 569);
	assert.deepEqual(Object.keys(detect.jsonSchema.properties), [
		"vendor",
		"plan",
		"amount",
		"currency",
		"cycle",
		"nextRenewalOn",
		"trialEndsOn",
		"docType",
	]);
});

test("toModelExtensionSchema keeps zod's properties, closes the object and requires nothing", () => {
	const schema = toModelExtensionSchema(
		z
			.object({
				name: z.string().max(80).nullable(),
				kind: z.enum(["a", "b"]).nullable(),
			})
			.strict(),
	);
	assert.deepEqual(Object.keys(schema).sort(), ["additionalProperties", "properties", "type"]);
	assert.equal(schema.type, "object");
	assert.equal(schema.additionalProperties, false);
	assert.deepEqual(schema.properties.kind, { anyOf: [{ type: "string", enum: ["a", "b"] }, { type: "null" }] });
	assert.deepEqual(schema.properties.name, { anyOf: [{ type: "string", maxLength: 80 }, { type: "null" }] });
	assert.deepEqual(toModelExtensionSchema(z.object({})).properties, {});
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
	assert.deepEqual(names("webhook_event", IDS), [
		"eventCreated",
		"eventUpdated",
		"eventDeleted",
		"appointmentCreated",
		"subscriptionDetected",
		"renewalDue",
	]);
	assert.deepEqual(names("webhook_event", ["booking", "calendar"]), [
		"eventCreated",
		"eventUpdated",
		"eventDeleted",
		"appointmentCreated",
	]);
	assert.deepEqual(names("webhook_event", ["booking"]), ["appointmentCreated"]);
	assert.deepEqual(names("jmap_method", IDS), []);
	assert.deepEqual(names("cron", ["import"]), ["resumeStalledImports"]);
	assert.deepEqual(names("cron", IDS), ["resumeStalledImports", "remindRenewals"]);
	assert.deepEqual(names("webhook_event", ["finance"]), ["subscriptionDetected", "renewalDue"]);
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
