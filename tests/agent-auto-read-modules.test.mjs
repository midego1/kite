import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { z } from "zod";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = makeBundleDirectory("kite-agent-auto-read-modules-");
after(() => rmSync(outDir, { recursive: true, force: true }));

await build({
	entryPoints: {
		steps: join(root, "src/lib/agent/auto-read/module-steps-utils.ts"),
		actions: join(root, "src/lib/agent/auto-read/module-actions-utils.ts"),
		registry: join(root, "src/lib/modules/capability-registry.ts"),
		activity: join(root, "src/components/agent/agent-activity-utils.ts"),
		actionsUtils: join(root, "src/lib/agent/auto-read/actions-utils.ts"),
		clientData: join(root, "src/lib/modules/client-data/index.ts"),
	},
	outdir: outDir,
	outExtension: { ".js": ".mjs" },
	bundle: true,
	sourcemap: "inline",
	platform: "node",
	format: "esm",
	target: "node22",
	logLevel: "silent",
	packages: "external",
	tsconfig: join(root, "tsconfig.json"),
});
const load = (name) => import(pathToFileURL(join(outDir, `${name}.mjs`)).href);
const steps = await load("steps");
const actions = await load("actions");
const { MODULE_CAPABILITIES } = await load("registry");
const { reasonText, actionLabel } = await load("activity");
const { ACTION_REGISTRY, getActionMeta } = await load("actionsUtils");
const { CLIENT_MODULES } = await load("clientData");

const payloadSchemas = { calendar_invite: z.object({ uid: z.string(), summary: z.string() }) };
const validate = (output, extra = {}) =>
	steps.validateStepOutput({
		moduleId: "calendar",
		ownedKinds: ["calendar_invite"],
		payloadSchemaFor: (kind) => payloadSchemas[kind] ?? null,
		output,
		...extra,
	});
const draft = (uid = "u1", extra = {}) => ({
	kind: "calendar_invite",
	payload: { uid, summary: "Planning" },
	reason: "calendar_invite",
	...extra,
});

test("a valid step suggestion is accepted with core's own fields only", () => {
	const result = validate({ suggestions: [draft("u1", { messageId: "someone-elses-message", id: "x" })] });
	assert.deepEqual(result.accepted, [
		{
			kind: "calendar_invite",
			payload: { uid: "u1", summary: "Planning" },
			reason: "calendar_invite",
			autoExecute: false,
		},
	]);
	assert.deepEqual(result.rejected, []);
});

test("a kind the module does not declare, another module's kind or a core kind is rejected", () => {
	for (const kind of ["reply", "summary", "phishing", "booking_slot"]) {
		const result = validate({ suggestions: [draft("u1", { kind }), draft("u2")] });
		assert.deepEqual(
			result.accepted.map((item) => item.payload.uid),
			["u2"],
			kind,
		);
		assert.deepEqual(result.rejected, [{ kind, why: "kind" }], kind);
	}
});

test("a payload that fails the kind's schema is rejected and the valid ones still pass", () => {
	const result = validate({
		suggestions: [{ ...draft("u1"), payload: { uid: 5 } }, draft("u2")],
	});
	assert.deepEqual(
		result.accepted.map((item) => item.payload.uid),
		["u2"],
	);
	assert.deepEqual(result.rejected, [{ kind: "calendar_invite", why: "payload" }]);
});

test("a kind with no payload schema is rejected rather than trusted", () => {
	const result = validate({ suggestions: [draft()] }, { payloadSchemaFor: () => null });
	assert.deepEqual(result.accepted, []);
	assert.deepEqual(result.rejected, [{ kind: "calendar_invite", why: "payload" }]);
});

test("at most three suggestions come from one step; the rest are rejected", () => {
	const result = validate({ suggestions: [draft("1"), draft("2"), draft("3"), draft("4"), draft("5")] });
	assert.deepEqual(
		result.accepted.map((item) => item.payload.uid),
		["1", "2", "3"],
	);
	assert.deepEqual(result.rejected, [
		{ kind: "calendar_invite", why: "limit" },
		{ kind: "calendar_invite", why: "limit" },
	]);
});

test("a malformed step answer yields nothing and never throws", () => {
	for (const output of [null, "x", 5, {}, { suggestions: "no" }, { suggestions: [null, 5, { kind: 3 }] }]) {
		const result = validate(output);
		assert.deepEqual(result.accepted, [], JSON.stringify(output));
	}
});

test("a skipped step is recorded as module_disabled with the module id", () => {
	assert.equal(steps.stepSkipReason("calendar"), "module_disabled:calendar");
	assert.equal(steps.joinSkipReasons(["calendar", "booking"]), "module_disabled:calendar,module_disabled:booking");
	assert.equal(steps.joinSkipReasons([]), null);
	assert.deepEqual(steps.splitSkipReasons("module_disabled:calendar,module_disabled:booking"), [
		"module_disabled:calendar",
		"module_disabled:booking",
	]);
	assert.deepEqual(steps.splitSkipReasons("daily_limit"), ["daily_limit"]);
});

test("suggestion kinds belong to the module whose descriptor declares them", () => {
	assert.deepEqual(steps.suggestionKindOwners(MODULE_CAPABILITIES), { calendar_invite: "calendar" });
	assert.deepEqual(steps.hiddenSuggestionKinds(MODULE_CAPABILITIES, ["calendar", "booking"]), []);
	assert.deepEqual(steps.hiddenSuggestionKinds(MODULE_CAPABILITIES, ["booking"]), ["calendar_invite"]);
	assert.deepEqual(steps.hiddenSuggestionKinds(MODULE_CAPABILITIES, []), ["calendar_invite"]);
});

test("the client's suggestion kinds match the kinds the descriptors declare", () => {
	const owners = steps.suggestionKindOwners(MODULE_CAPABILITIES);
	const declared = CLIENT_MODULES.flatMap((entry) => (entry.suggestionKinds ?? []).map((kind) => [kind, entry.id]));
	assert.deepEqual(Object.fromEntries(declared), owners);
});

test("triage steps list in order for modules that are on", () => {
	assert.deepEqual(
		steps.triageStepsFor(MODULE_CAPABILITIES).map((step) => [step.moduleId, step.capability, step.requires]),
		[["calendar", "invite", "invite_attachment"]],
	);
});

test("module actions register from their descriptors with the rules calendar used before", () => {
	const registry = actions.buildModuleActions(MODULE_CAPABILITIES);
	assert.deepEqual(Object.keys(registry.meta).sort(), ["create_event", "delete_event", "send_rsvp"]);
	assert.deepEqual(registry.owners.create_event, { moduleId: "calendar", capability: "createEvent" });
	assert.deepEqual(registry.owners.delete_event, { moduleId: "calendar", capability: "deleteEvent" });
	assert.deepEqual(registry.owners.send_rsvp, { moduleId: "calendar", capability: "sendRsvp" });
	const week = 7 * 24 * 60 * 60 * 1000;
	assert.deepEqual(registry.meta.create_event, {
		executePermission: "manage",
		variants: ["", "update"],
		undo: {
			"*": { windowMs: week, permission: "manage", actingUserOnly: false, inverseAction: "delete_event" },
			update: { windowMs: week, permission: "manage", actingUserOnly: false },
		},
	});
	assert.deepEqual(registry.meta.delete_event, {
		executePermission: "manage",
		variants: [""],
		undo: { "*": { windowMs: week, permission: "manage", actingUserOnly: false, inverseAction: "create_event" } },
	});
	assert.deepEqual(registry.meta.send_rsvp, {
		executePermission: "send_on_behalf",
		variants: ["accepted", "declined"],
		undo: { "*": { windowMs: week, permission: "send_on_behalf", actingUserOnly: true } },
	});
});

test("the action registry includes the module actions, so older rows still resolve", () => {
	for (const action of ["create_event", "delete_event", "send_rsvp"]) assert.ok(ACTION_REGISTRY[action], action);
	assert.deepEqual(getActionMeta("send_rsvp").variants, ["accepted", "declined"]);
	assert.equal(actions.moduleActionOwner("create_event")?.moduleId, "calendar");
	assert.equal(actions.moduleActionOwner("dismiss"), null);
	assert.equal(actions.moduleActionOwner("move"), null);
});

test("an action descriptor without its rules registers nothing", () => {
	const registry = actions.buildModuleActions([
		{
			moduleId: "calendar",
			promptFragment: null,
			descriptors: [
				{
					name: "broken",
					surfaces: ["action"],
					description: "x",
					inputSchema: {},
					effect: "create",
					action: { actionType: "broken_action", undoable: true },
				},
			],
		},
	]);
	assert.deepEqual(registry.meta, {});
});

test("Activity words come from the manifests, including the module-off reason", () => {
	assert.equal(reasonText("module_disabled:calendar"), "Calendar is turned off");
	assert.equal(reasonText("module_disabled:booking"), "Booking is turned off");
	assert.equal(
		reasonText("module_disabled:calendar,module_disabled:booking"),
		"Calendar is turned off, Booking is turned off",
	);
	assert.equal(reasonText("capability_calendar_off"), "Blocked: calendar suggestions are off");
	assert.equal(actionLabel({ action: "create_event", variant: "", undoOf: null }), "Added an event to the calendar");
	assert.equal(actionLabel({ action: "send_rsvp", variant: "declined", undoOf: null }), "Declined an invitation");
	assert.equal(
		actionLabel({ action: "create_event", variant: "update", undoOf: "a1" }),
		"Undid: updated a calendar event",
	);
});
