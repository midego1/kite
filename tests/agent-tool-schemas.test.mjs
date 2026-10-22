import assert from "node:assert/strict";
import test from "node:test";
import { zodSchema } from "ai";
import { z } from "zod";
import { bundleModules } from "./support/modules-bundle.mjs";

const {
	emailToolSchemas,
	calendarToolSchemas,
	MODULE_CAPABILITIES,
	SERVER_MODULES,
	navigateCommands,
	openPageSchema,
	listCommands,
	MODULE_IDS,
} = await bundleModules("kite-agent-tool-schemas-", [
	["emailToolSchemas", "src/lib/agent/tools.ts"],
	["calendarToolSchemas", "src/lib/calendar/tool-schemas.ts"],
	["MODULE_CAPABILITIES", "src/lib/modules/capability-registry.ts"],
	["SERVER_MODULES", "src/lib/modules/server-registry.ts"],
	["navigateCommands, openPageSchema", "src/lib/agent/chat-tools-utils.ts"],
	["listCommands", "src/components/shortcuts/command-palette-utils.ts"],
	["MODULE_IDS", "src/lib/modules/registry.ts"],
]);

const LOOKAROUND = /\(\?(?:[=!]|<[=!])/;
const TOOL_SURFACES = new Set(["assistant_tool", "mcp_tool"]);

function lookaroundPatterns(schema, path = "$") {
	if (!schema || typeof schema !== "object") return [];
	if (Array.isArray(schema)) return schema.flatMap((item, index) => lookaroundPatterns(item, `${path}[${index}]`));
	return Object.entries(schema).flatMap(([key, value]) =>
		key === "pattern" && typeof value === "string"
			? LOOKAROUND.test(value)
				? [`${path}.pattern: ${value}`]
				: []
			: lookaroundPatterns(value, `${path}.${key}`),
	);
}

/** The JSON Schemas a zod tool schema becomes: `streamText` sends `zodSchema().jsonSchema`, the MCP server the standard-schema input. */
function providerSchemas(schema) {
	return [zodSchema(schema).jsonSchema, schema["~standard"].jsonSchema.input({ target: "draft-2020-12" })];
}

function allToolSchemas() {
	const entries = [];
	for (const [name, schema] of Object.entries(emailToolSchemas)) {
		for (const json of providerSchemas(schema)) entries.push([`email ${name}`, json]);
		const mcp = z.object({ mailboxId: z.string().min(1), ...schema.shape });
		for (const json of providerSchemas(mcp)) entries.push([`mcp ${name}`, json]);
	}
	for (const [name, schema] of Object.entries(calendarToolSchemas)) {
		for (const json of providerSchemas(schema)) entries.push([`calendar ${name}`, json]);
	}
	for (const { moduleId, descriptors } of MODULE_CAPABILITIES) {
		for (const descriptor of descriptors) {
			if (!descriptor.surfaces.some((surface) => TOOL_SURFACES.has(surface))) continue;
			entries.push([`${moduleId} ${descriptor.name} descriptor`, descriptor.inputSchema]);
			const input = SERVER_MODULES[moduleId]?.schemas[descriptor.name]?.input;
			if (input) for (const json of providerSchemas(input)) entries.push([`${moduleId} ${descriptor.name}`, json]);
		}
	}
	const commands = navigateCommands(listCommands({ enabled: [...MODULE_IDS] }));
	entries.push(["open_page", openPageSchema(commands)]);
	return entries;
}

test("the lookaround check finds lookahead and lookbehind patterns anywhere in a schema", () => {
	const naive = z.object({
		to: z.string().regex(/^(?!\.)[^@]+@[^@]+$/),
		list: z.array(z.object({ address: z.string().regex(/^(?!\.)[^@]+@[^@]+$/) })),
	});
	assert.equal(lookaroundPatterns(zodSchema(naive).jsonSchema).length, 2);
	assert.deepEqual(lookaroundPatterns({ pattern: "^(?<=a)b$" }), ["$.pattern: ^(?<=a)b$"]);
	assert.deepEqual(lookaroundPatterns({ pattern: "^[a-z]+$" }), []);
});

test("no assistant or MCP tool schema uses regex lookaround, which OpenRouter rejects", () => {
	const entries = allToolSchemas();
	assert.ok(entries.some(([name]) => name.startsWith("email draft_email")));
	assert.ok(entries.some(([name]) => name.startsWith("calendar create_event")));
	assert.ok(entries.some(([name]) => name.startsWith("finance ")));
	const offenders = entries.flatMap(([name, json]) => lookaroundPatterns(json).map((found) => `${name}: ${found}`));
	assert.deepEqual(offenders, []);
});

test("email fields are still validated when a tool runs and are described as email to the model", () => {
	const draft = { subject: "Hi", body: "Hello" };
	assert.equal(emailToolSchemas.draft_email.safeParse({ ...draft, to: "not-an-email" }).success, false);
	assert.equal(emailToolSchemas.draft_email.safeParse({ ...draft, to: "a..b@example.com" }).success, false);
	assert.equal(emailToolSchemas.draft_email.safeParse({ ...draft, to: "owner@example.com" }).success, true);
	assert.equal(zodSchema(emailToolSchemas.draft_email).jsonSchema.properties.to.format, "email");

	const event = { title: "Meet", startsAt: "2026-10-12T15:00:00.000Z", endsAt: "2026-10-12T16:00:00.000Z" };
	const create = calendarToolSchemas.create_event;
	assert.equal(create.safeParse({ ...event, attendees: ["not-an-email"] }).success, false);
	assert.equal(create.safeParse({ ...event, attendees: ["owner@example.com"] }).success, true);
	const update = calendarToolSchemas.update_events;
	assert.equal(update.safeParse({ updates: [{ eventId: "evt-1", attendees: ["a..b@example.com"] }] }).success, false);
	assert.equal(update.safeParse({ updates: [{ eventId: "evt-1", attendees: ["owner@example.com"] }] }).success, true);
});

test("list_emails takes an optional, nullable, described cursor", () => {
	const schema = emailToolSchemas.list_emails;
	assert.equal(schema.safeParse({ folder: "inbox", limit: 1 }).success, true);
	assert.equal(schema.safeParse({ folder: "inbox", limit: 1, cursor: null }).success, true);
	assert.equal(schema.safeParse({ folder: "inbox", limit: 1, cursor: "" }).success, false);
	for (const json of providerSchemas(schema)) {
		assert.equal(json.required?.includes("cursor") ?? false, false);
		assert.match(json.properties.cursor.description, /first page/);
		assert.match(json.properties.cursor.description, /nextCursor/);
		assert.ok(json.properties.cursor.anyOf.some((option) => option.type === "null"));
	}
});
