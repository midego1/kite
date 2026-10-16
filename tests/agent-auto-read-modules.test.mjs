import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { z } from "zod";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";
import { bundleModules } from "./support/modules-bundle.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = makeBundleDirectory("kite-agent-auto-read-modules-");
after(() => rmSync(outDir, { recursive: true, force: true }));

await build({
	entryPoints: {
		steps: join(root, "src/lib/agent/auto-read/module-steps-utils.ts"),
		stepInput: join(root, "src/lib/agent/auto-read/step-input-utils.ts"),
		sharedSchemas: join(root, "src/lib/modules/shared-schemas.ts"),
		actions: join(root, "src/lib/agent/auto-read/module-actions-utils.ts"),
		registry: join(root, "src/lib/modules/capability-registry.ts"),
		activity: join(root, "src/components/agent/agent-activity-utils.ts"),
		actionsUtils: join(root, "src/lib/agent/auto-read/actions-utils.ts"),
		clientData: join(root, "src/lib/modules/client-data/index.ts"),
		suggestionUtils: join(root, "src/lib/agent/auto-read/suggestion-utils.ts"),
		badge: join(root, "src/lib/agent/auto-read/suggestion-badge-utils.ts"),
		forYou: join(root, "src/lib/agent/auto-read/for-you-utils.ts"),
		card: join(root, "src/components/agent/suggestion-card-utils.ts"),
		refs: join(root, "src/lib/agent/auto-read/activity-ref-utils.ts"),
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
const { buildStepInput, stepHeaders, stepTextExcerpt, STEP_TEXT_EXCERPT_CHARS } = await load("stepInput");
const { triageStepSchemas, baseTriageStepSchemas } = await load("sharedSchemas");
const actions = await load("actions");
const { MODULE_CAPABILITIES } = await load("registry");
const { reasonText, actionLabel } = await load("activity");
const { ACTION_REGISTRY, getActionMeta } = await load("actionsUtils");
const { CLIENT_MODULES } = await load("clientData");
const { parseSuggestionPayload, suggestionTitle } = await load("suggestionUtils");
const { SUGGESTION_KIND_ORDER, pickSuggestionBadge, suggestionKindRanking } = await load("badge");
const { FOR_YOU_KIND_LABELS } = await load("forYou");
const { cardSections, whyDetails } = await load("card");
const { moduleActionRef } = await load("refs");
const { SqliteDatabase, applyMigrations, reopenSuggestionIfIdle } = await bundleModules("kite-auto-read-reopen-", [
	["SqliteDatabase", "server/runtime/sqlite-database.ts"],
	["applyMigrations", "server/runtime/migrate.ts"],
	["reopenSuggestionIfIdle", "src/lib/agent/auto-read/suggestion-reopen.ts"],
]);

/** A module that exists only in these tests, so the core rules are checked without naming a real module. */
const TEST_MODULE = {
	moduleId: "testmod",
	promptFragment: null,
	descriptors: [
		{
			name: "widgetOffer",
			surfaces: ["suggestion_kind"],
			description: "x",
			inputSchema: {},
			effect: "none",
			suggestionKind: { kind: "widget_offer", label: "Widget offer", reasonTemplate: "widget" },
		},
		{
			name: "makeWidget",
			surfaces: ["action"],
			description: "x",
			inputSchema: {},
			effect: "create",
			action: {
				actionType: "make_widget",
				undoable: true,
				permission: "manage",
				variants: [""],
				reopensSuggestion: true,
			},
		},
		{
			name: "tuneWidget",
			surfaces: ["action"],
			description: "x",
			inputSchema: {},
			effect: "update",
			action: { actionType: "tune_widget", undoable: true, permission: "manage", variants: [""] },
		},
	],
};

/** A second test-only module with a reviewer-only kind and an automatic, switchable triage step. */
const PRIVATE_MODULE = {
	moduleId: "privmod",
	promptFragment: null,
	descriptors: [
		{
			name: "scan",
			surfaces: ["triage_step"],
			description: "x",
			inputSchema: {},
			effect: "read",
			triage: { order: 20, automatic: true, capability: "gadgets" },
		},
		{
			name: "gadgetNote",
			surfaces: ["suggestion_kind"],
			description: "x",
			inputSchema: {},
			effect: "none",
			suggestionKind: { kind: "gadget_note", label: "Gadget", reasonTemplate: "gadget", audience: "reviewer" },
		},
		{
			name: "plainStep",
			surfaces: ["triage_step"],
			description: "x",
			inputSchema: {},
			effect: "read",
			triage: { order: 5 },
		},
	],
};
const CORE_CAPABILITIES = { calendar: true, reply: true, summary: true, phishing: true, mutedSenders: [], modules: {} };

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
	assert.deepEqual(steps.suggestionKindOwners(MODULE_CAPABILITIES), {
		calendar_invite: "calendar",
		subscription: "finance",
	});
	assert.deepEqual(steps.suggestionKindOwners([...MODULE_CAPABILITIES, TEST_MODULE]), {
		calendar_invite: "calendar",
		subscription: "finance",
		widget_offer: "testmod",
	});
	assert.deepEqual(steps.hiddenSuggestionKinds(MODULE_CAPABILITIES, ["calendar", "booking", "finance"]), []);
	assert.deepEqual(steps.hiddenSuggestionKinds(MODULE_CAPABILITIES, ["booking", "finance"]), ["calendar_invite"]);
	assert.deepEqual(steps.hiddenSuggestionKinds(MODULE_CAPABILITIES, ["calendar"]), ["subscription"]);
	assert.deepEqual(steps.hiddenSuggestionKinds(MODULE_CAPABILITIES, []), ["calendar_invite", "subscription"]);
});

test("the client's suggestion kinds match the kinds the descriptors declare", () => {
	const owners = steps.suggestionKindOwners(MODULE_CAPABILITIES);
	const declared = CLIENT_MODULES.flatMap((entry) => (entry.suggestionKinds ?? []).map((kind) => [kind, entry.id]));
	assert.deepEqual(Object.fromEntries(declared), owners);
});

test("triage steps list in order for modules that are on", () => {
	assert.deepEqual(
		steps.triageStepsFor(MODULE_CAPABILITIES).map((step) => [step.moduleId, step.capability, step.requires]),
		[
			["calendar", "invite", "invite_attachment"],
			["finance", "detect", undefined],
		],
	);
});

test("audience: only reviewer kinds are reviewer-only, and only the reviewer can see them", () => {
	assert.deepEqual(steps.reviewerOnlySuggestionKinds(MODULE_CAPABILITIES), ["subscription"]);
	assert.deepEqual(steps.reviewerOnlySuggestionKinds([...MODULE_CAPABILITIES, TEST_MODULE, PRIVATE_MODULE]), [
		"subscription",
		"gadget_note",
	]);
	const reviewerOnly = ["gadget_note"];
	const row = { kind: "gadget_note", reviewerUserId: "reviewer" };
	assert.equal(steps.hiddenFromViewer(row, "reviewer", reviewerOnly), false);
	assert.equal(steps.hiddenFromViewer(row, "colleague", reviewerOnly), true);
	assert.equal(steps.hiddenFromViewer({ ...row, kind: "widget_offer" }, "colleague", reviewerOnly), false);
	assert.equal(steps.hiddenFromViewer({ ...row, kind: "summary" }, "colleague", reviewerOnly), false);
});

test("triage steps carry their automatic opt-in and switch key", () => {
	assert.deepEqual(
		steps.triageStepsFor([PRIVATE_MODULE]).map((step) => [step.capability, step.order, step.automatic, step.switchKey]),
		[
			["plainStep", 5, false, null],
			["scan", 20, true, "gadgets"],
		],
	);
	assert.deepEqual(
		steps.triageStepsFor(MODULE_CAPABILITIES).map((step) => [step.moduleId, step.automatic, step.switchKey]),
		[
			["calendar", false, null],
			["finance", true, "subscriptions"],
		],
	);
});

test("the mailbox module switch: a module step's key in capabilities.modules, on unless set to false", () => {
	const [plain, scan] = steps.triageStepsFor([PRIVATE_MODULE]);
	assert.equal(steps.stepSwitchOn(scan, CORE_CAPABILITIES), true);
	assert.equal(steps.stepSwitchOn(scan, { ...CORE_CAPABILITIES, modules: { gadgets: true } }), true);
	assert.equal(steps.stepSwitchOn(scan, { ...CORE_CAPABILITIES, modules: { gadgets: false } }), false);
	assert.equal(steps.stepSwitchOn(scan, { ...CORE_CAPABILITIES, modules: undefined }), true);
	assert.equal(steps.stepSwitchOn(scan, { ...CORE_CAPABILITIES, modules: { other: false } }), true);
	assert.equal(steps.stepSwitchOn(plain, { ...CORE_CAPABILITIES, modules: { gadgets: false } }), true);
	// Calendar keeps its core key, whatever capabilities.modules says.
	const [invite] = steps.triageStepsFor(MODULE_CAPABILITIES);
	assert.equal(steps.stepSwitchOn(invite, CORE_CAPABILITIES), true);
	assert.equal(steps.stepSwitchOn(invite, { ...CORE_CAPABILITIES, calendar: false }), false);
	assert.equal(
		steps.stepSwitchOn(invite, { ...CORE_CAPABILITIES, calendar: false, modules: { calendar: true } }),
		false,
	);
});

test("due steps: switched on, with their fact, and only opted-in steps on a steps-only pass", () => {
	const all = steps.triageStepsFor([...MODULE_CAPABILITIES, PRIVATE_MODULE]);
	const due = (input) =>
		steps
			.selectDueSteps(all, { inviteAttachments: 1, capabilities: CORE_CAPABILITIES, automaticOnly: false, ...input })
			.map((step) => step.capability);
	assert.deepEqual(due({}), ["plainStep", "invite", "detect", "scan"]);
	assert.deepEqual(due({ inviteAttachments: 0 }), ["plainStep", "detect", "scan"]);
	assert.deepEqual(due({ automaticOnly: true }), ["detect", "scan"]);
	assert.deepEqual(due({ capabilities: { ...CORE_CAPABILITIES, modules: { gadgets: false } } }), [
		"plainStep",
		"invite",
		"detect",
	]);
	const off = { gadgets: false, subscriptions: false };
	assert.deepEqual(due({ automaticOnly: true, capabilities: { ...CORE_CAPABILITIES, modules: off } }), []);
	assert.deepEqual(due({ capabilities: { ...CORE_CAPABILITIES, calendar: false } }), ["plainStep", "detect", "scan"]);
});

test("a finished job's note names the refused model first, then the skipped modules", () => {
	assert.equal(steps.joinSkipReasons([], "rate_limited"), "rate_limited");
	assert.equal(steps.joinSkipReasons(["testmod"], "spend_cap"), "spend_cap,module_disabled:testmod");
	assert.equal(steps.joinSkipReasons(["testmod"], null), "module_disabled:testmod");
	assert.equal(
		reasonText("external_provider_not_allowed,module_disabled:calendar"),
		"Skipped: the external AI provider is not allowed to read mail automatically, Calendar is turned off",
	);
});

const stepFacts = {
	senderAddress: "billing@vendor.test",
	senderName: "Vendor Billing",
	automatic: true,
	bulk: true,
	list: true,
	noReply: false,
	authPassed: true,
	knownContact: false,
	phishingSignals: [],
	spamVerdict: "inbox",
	inviteAttachments: [],
};
const stepSource = {
	id: "m1",
	fromAddr: "Vendor Billing <billing@vendor.test>",
	subject: "Your receipt",
	createdAt: new Date("2030-01-02T03:04:05.000Z"),
};

test("the wider step input carries the sender name, an 8 KB excerpt, extra facts and three list headers", () => {
	const input = buildStepInput({
		source: stepSource,
		mailboxId: "mb1",
		facts: stepFacts,
		headers: {
			"list-unsubscribe": " <https://vendor.test/u/1>, <mailto:u@vendor.test> ",
			"list-unsubscribe-post": "List-Unsubscribe=One-Click",
			"list-id": "<news.vendor.test>",
			"x-other": "dropped",
		},
		bodyText: "Total 9.99",
		attachments: [{ id: "a1", contentType: "application/pdf", filename: "r.pdf", size: 10 }],
		model: null,
	});
	assert.deepEqual(input, {
		message: {
			id: "m1",
			mailboxId: "mb1",
			from: "Vendor Billing <billing@vendor.test>",
			fromName: "Vendor Billing",
			subject: "Your receipt",
			receivedAt: "2030-01-02T03:04:05.000Z",
			textExcerpt: "Total 9.99",
		},
		facts: {
			authPassed: true,
			bulk: true,
			knownContact: false,
			phishing: [],
			automatic: true,
			noReply: false,
			list: true,
			spam: false,
		},
		headers: {
			listUnsubscribe: "<https://vendor.test/u/1>, <mailto:u@vendor.test>",
			listUnsubscribePost: "List-Unsubscribe=One-Click",
			listId: "<news.vendor.test>",
		},
		attachments: [{ id: "a1", contentType: "application/pdf", filename: "r.pdf", size: 10 }],
		model: null,
	});
	assert.equal(triageStepSchemas.input.safeParse(input).success, true);
	const spam = buildStepInput({
		...input,
		source: stepSource,
		mailboxId: "mb1",
		facts: { ...stepFacts, spamVerdict: "spam" },
		headers: {},
		bodyText: "",
		attachments: [],
		model: { category: "fyi" },
	});
	assert.equal(spam.facts.spam, true);
	assert.equal(spam.message.textExcerpt, null);
	assert.deepEqual(spam.headers, { listUnsubscribe: null, listUnsubscribePost: null, listId: null });
	assert.deepEqual(spam.model, { category: "fyi" });
});

test("the excerpt stops at 8,192 characters without splitting a surrogate pair, and long headers, names and subjects are cut", () => {
	assert.equal(STEP_TEXT_EXCERPT_CHARS, 8_192);
	assert.equal(stepTextExcerpt(""), null);
	assert.equal(stepTextExcerpt("x".repeat(9_000)).length, 8_192);
	const emoji = `${"x".repeat(8_191)}😀tail`;
	assert.equal(stepTextExcerpt(emoji), "x".repeat(8_191));
	assert.equal(stepHeaders({ "list-id": "y".repeat(5_000) }).listId.length, 4_096);
	assert.equal(stepHeaders({ "list-id": "   " }).listId, null);
	assert.equal(stepHeaders(Object.create({ "list-id": "inherited" })).listId, null);
	const long = buildStepInput({
		source: { ...stepSource, subject: "s".repeat(10_000) },
		mailboxId: "mb1",
		facts: { ...stepFacts, senderName: " ".repeat(100_000) },
		headers: {},
		bodyText: "",
		attachments: [],
		model: null,
	});
	assert.equal(long.message.fromName.length, 256);
	assert.equal(long.message.subject.length, 4_096);
});

test("a step on the base schema gets exactly its old input: the new keys are stripped", () => {
	const input = buildStepInput({
		source: stepSource,
		mailboxId: "mb1",
		facts: stepFacts,
		headers: { "list-id": "<news.vendor.test>" },
		bodyText: "Body",
		attachments: [],
		model: null,
	});
	const parsed = baseTriageStepSchemas.input.parse(input);
	assert.deepEqual(parsed, {
		message: {
			id: "m1",
			mailboxId: "mb1",
			from: "Vendor Billing <billing@vendor.test>",
			subject: "Your receipt",
			receivedAt: "2030-01-02T03:04:05.000Z",
		},
		facts: { authPassed: true, bulk: true, knownContact: false, phishing: [] },
		attachments: [],
		model: null,
	});
});

test("every module step switch is declared in the module's client data, and no switch key is a core key", () => {
	for (const entry of MODULE_CAPABILITIES) {
		const keys = steps
			.triageStepsFor([entry])
			.map((step) => step.switchKey)
			.filter(Boolean);
		const client = CLIENT_MODULES.find((module) => module.id === entry.moduleId);
		assert.deepEqual(
			(client.triageSwitches ?? []).map((item) => item.key).sort(),
			[...new Set(keys)].sort(),
			entry.moduleId,
		);
		for (const key of keys) assert.ok(!Object.hasOwn(CORE_CAPABILITIES, key), `${entry.moduleId}: ${key}`);
	}
});

test("module actions register from their descriptors with the rules calendar used before", () => {
	const registry = actions.buildModuleActions(MODULE_CAPABILITIES);
	assert.deepEqual(Object.keys(registry.meta).sort(), [
		"create_event",
		"create_subscription",
		"delete_document",
		"delete_event",
		"delete_subscription",
		"record_document",
		"send_rsvp",
		"set_subscription_status",
		"update_subscription",
	]);
	assert.deepEqual(registry.owners.create_subscription, {
		moduleId: "finance",
		capability: "trackSubscription",
		reopensSuggestion: true,
	});
	assert.deepEqual(registry.owners.delete_document, { moduleId: "finance", capability: "deleteDocument" });
	assert.deepEqual(registry.meta.set_subscription_status.variants, ["active", "trial", "cancelled", "expired"]);
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

const CORE_STORED = ["summary", "phishing", "calendar_invite"];

test("triage stores the core kinds plus every kind a module declares, each once", () => {
	assert.deepEqual(steps.storedSuggestionKinds(CORE_STORED, MODULE_CAPABILITIES), [...CORE_STORED, "subscription"]);
	assert.deepEqual(steps.storedSuggestionKinds(CORE_STORED, [...MODULE_CAPABILITIES, TEST_MODULE]), [
		...CORE_STORED,
		"subscription",
		"widget_offer",
	]);
	assert.deepEqual(steps.suggestionKindDescriptors([...MODULE_CAPABILITIES, TEST_MODULE]), {
		calendar_invite: { moduleId: "calendar", capability: "calendar_invite", label: "Invitation" },
		subscription: { moduleId: "finance", capability: "subscription", label: "Subscription" },
		widget_offer: { moduleId: "testmod", capability: "widgetOffer", label: "Widget offer" },
	});
});

test("a module kind's payload is validated by the owning descriptor's schema, and an unknown kind is null", () => {
	const widget = z.object({ size: z.number().int().min(1) });
	assert.deepEqual(parseSuggestionPayload("widget_offer", { size: 3, extra: "dropped" }, widget), { size: 3 });
	assert.equal(parseSuggestionPayload("widget_offer", { size: 0 }, widget), null);
	assert.equal(parseSuggestionPayload("widget_offer", { size: 3 }), null);
	assert.equal(parseSuggestionPayload("widget_offer", { size: 3 }, null), null);
	assert.doesNotThrow(() => parseSuggestionPayload("constructor", {}));
	assert.equal(parseSuggestionPayload("constructor", {}), null);
	// A core kind keeps core's schema, whatever schema a caller passes.
	assert.equal(parseSuggestionPayload("summary", { anything: true }, z.object({}).passthrough()), null);
	assert.deepEqual(parseSuggestionPayload("summary", { text: "Short" }), { text: "Short" });
});

test("a step's title is kept cleaned: controls and bidi characters stripped, at most 120 characters", () => {
	const titled = (title) => validate({ suggestions: [draft("u1", { title })] }).accepted[0];
	assert.equal(titled("Plan  the\nweek").title, "Plan the week");
	assert.equal(titled("Pay\u202e\u2066ment\u200f due\u0007").title, "Payment due");
	const long = titled("x".repeat(300)).title;
	assert.equal(Array.from(long).length, 120);
	assert.ok(long.endsWith("…"));
	assert.equal(Array.from(titled("é".repeat(120)).title).length, 120);
	for (const title of [undefined, "", "   ", "\u202e\u200f", 42, null]) assert.equal("title" in titled(title), false);
	assert.equal(steps.cleanStepTitle("\u2067Safe\u2069"), "Safe");
});

test("the stored title is the step's own, else core's for a core kind, else the module kind's label", () => {
	const invite = {
		kind: "calendar_invite",
		payload: { summary: "Planning", method: "REQUEST", conflicts: [] },
	};
	assert.equal(suggestionTitle(invite), "Invitation: Planning");
	assert.equal(suggestionTitle({ kind: "summary", payload: { text: "x" } }), "Summary");
	assert.equal(
		suggestionTitle({ kind: "widget_offer", payload: {}, title: "Widget for 3" }, "Widget offer"),
		"Widget for 3",
	);
	assert.equal(suggestionTitle({ kind: "widget_offer", payload: {} }, "Widget offer"), "Widget offer");
	assert.equal(suggestionTitle({ kind: "widget_offer", payload: {} }), "Suggestion");
	assert.equal(suggestionTitle({ kind: "widget_offer", payload: {} }, "  "), "Suggestion");
});

test("Calendar's client meta keeps its label, chip rank, reason text and card position", () => {
	const meta = CLIENT_MODULES.find((entry) => entry.id === "calendar").suggestionKindMeta;
	assert.deepEqual(Object.keys(meta), ["calendar_invite"]);
	assert.equal(FOR_YOU_KIND_LABELS.calendar_invite, "Invitations");
	assert.deepEqual(SUGGESTION_KIND_ORDER, [
		"phishing",
		"calendar_invite",
		"reply",
		"task",
		"subscription",
		"receipt",
		"summary",
		"label",
		"unsubscribe",
		"follow_up",
	]);
	assert.deepEqual(
		pickSuggestionBadge([
			{ kind: "reply", count: 1 },
			{ kind: "calendar_invite", count: 1 },
		]),
		{ kind: "calendar_invite", more: 1 },
	);
	const item = (id, kind) => ({ id, kind, status: "open", mailboxId: "m1", payload: { reason: kind } });
	const sections = cardSections([item("r", "reply"), item("c", "calendar_invite"), item("p", "phishing")], "m1");
	assert.deepEqual(
		sections.blocks.map((entry) => entry.kind),
		["phishing", "calendar_invite", "reply"],
	);
	assert.equal(whyDetails(item("c", "calendar_invite")).reason, "The message contains a calendar invitation.");
	assert.equal(
		whyDetails({ ...item("c", "calendar_invite"), payload: { reason: "constructor" } }).reason,
		"Kite's rules for this mailbox suggested this.",
	);
	for (const entry of CLIENT_MODULES)
		assert.deepEqual(
			Object.keys(entry.suggestionKindMeta ?? {}).sort(),
			[...(entry.suggestionKinds ?? [])].sort(),
			entry.id,
		);
});

test("module kinds rank by their badgePriority among the core kinds, and kinds without one get no chip", () => {
	const ranking = suggestionKindRanking([
		{ suggestionKindMeta: { early: { label: "Early", reason: {}, badgePriority: 5 } } },
		{
			suggestionKindMeta: {
				between: { label: "Between", reason: {}, badgePriority: 30 },
				quiet: { label: "Quiet", reason: {} },
			},
		},
	]);
	assert.deepEqual(ranking.badge, ["early", "phishing", "reply", "between", "task", "receipt"]);
	assert.deepEqual(ranking.order, [...ranking.badge, "summary", "label", "unsubscribe", "follow_up", "quiet"]);
	assert.deepEqual(suggestionKindRanking([]).badge, ["phishing", "reply", "task", "receipt"]);
});

test("a module action may reopen its suggestion on undo, and Activity reads the ref its result recorded", () => {
	const registry = actions.buildModuleActions([TEST_MODULE]);
	assert.deepEqual(registry.owners.make_widget, {
		moduleId: "testmod",
		capability: "makeWidget",
		reopensSuggestion: true,
	});
	assert.deepEqual(registry.owners.tune_widget, { moduleId: "testmod", capability: "tuneWidget" });
	assert.equal(actions.moduleActionOwner("create_event").reopensSuggestion, undefined);
	assert.deepEqual(actions.moduleActionTypes("calendar").sort(), ["create_event", "delete_event", "send_rsvp"]);
	assert.deepEqual(actions.moduleActionTypes("booking"), []);
	const ref = (value) => moduleActionRef({ after: { ref: value } }, "testmod");
	assert.deepEqual(ref({ kind: "testmod:widget", id: "w1" }), { kind: "testmod:widget", id: "w1" });
	for (const value of [
		{ kind: "calendar:event", id: "w1" },
		{ kind: "testmod:", id: "w1" },
		{ kind: "testmod:widget", id: "" },
		{ kind: "testmod:widget", id: "x".repeat(161) },
		{ kind: "testmod:widget" },
		"testmod:widget:w1",
		["testmod:widget", "w1"],
		null,
	])
		assert.equal(ref(value), null, JSON.stringify(value));
	assert.equal(moduleActionRef({ after: null }, "testmod"), null);
	assert.deepEqual(
		moduleActionRef({ after: { ref: { kind: "calendar:event", id: "e2" }, eventId: "e1" } }, "calendar"),
		{ kind: "calendar:event", id: "e2" },
	);
});

async function reopenDatabase(t) {
	const db = new SqliteDatabase(":memory:");
	t.after(() => db.db.close());
	await applyMigrations(db, join(root, "drizzle/migrations"));
	db.db.exec(`
		INSERT INTO users (id, email, password_hash, name, created_at) VALUES ('owner', 'owner@example.com', 'hash', 'Owner', 1);
		INSERT INTO domains (id, user_id, hostname, zone_id, status, created_at) VALUES ('domain-1', 'owner', 'example.com', 'zone-1', 'active', 1);
		INSERT INTO mailboxes (id, user_id, domain_id, local_part, created_at) VALUES ('mailbox-a', 'owner', 'domain-1', 'a', 1);
		INSERT INTO messages (id, user_id, mailbox_id, direction, from_addr, to_addr, subject, text_body, status, created_at) VALUES
			('message-1', 'owner', 'mailbox-a', 'inbound', 'shop@example.net', 'a@example.com', 'Widget', 'Hello', 'received', 2);
		INSERT INTO agent_suggestions (id, mailbox_id, message_id, reviewer_user_id, kind, status, title, payload, created_at, decided_at, decided_by_user_id) VALUES
			('sug-1', 'mailbox-a', 'message-1', 'owner', 'widget_offer', 'accepted', 'Widget for 3', '{}', 3, 4, 'owner'),
			('sug-2', 'mailbox-a', 'message-1', 'owner', 'other_offer', 'dismissed', 'Other', '{}', 3, 4, 'owner');
	`);
	const action = (id, suggestionId, type, status, variant = "") =>
		db.db
			.prepare(
				`INSERT INTO agent_actions (id, mailbox_id, suggestion_id, message_id, initiator, acting_user_id, action, variant, status, created_at, updated_at)
				VALUES (?, 'mailbox-a', ?, 'message-1', 'user', 'owner', ?, ?, ?, 5, 5)`,
			)
			.run(id, suggestionId, type, variant, status);
	const suggestion = (id) =>
		db.db.prepare("SELECT status, decided_at, decided_by_user_id FROM agent_suggestions WHERE id = ?").get(id);
	return { env: { DB: db }, db, action, suggestion };
}

test("after an undo the suggestion reopens only once no live action of the module remains", async (t) => {
	const { env, db, action, suggestion } = await reopenDatabase(t);
	const types = ["make_widget", "tune_widget"];
	action("a1", "sug-1", "make_widget", "undone");
	action("a2", "sug-1", "make_widget", "applied", "undo:a1");
	action("a3", "sug-1", "tune_widget", "applied");
	assert.equal(await reopenSuggestionIfIdle(env, "sug-1", types), false);
	assert.equal(suggestion("sug-1").status, "accepted");
	// An action of another module, or a core action, does not keep it decided.
	db.db.exec("UPDATE agent_actions SET status = 'undone' WHERE id = 'a3'");
	action("a4", "sug-1", "create_event", "applied");
	action("a5", "sug-1", "dismiss", "applied");
	assert.equal(await reopenSuggestionIfIdle(env, "sug-1", types), true);
	assert.deepEqual(suggestion("sug-1"), { status: "open", decided_at: null, decided_by_user_id: null });
	assert.equal(await reopenSuggestionIfIdle(env, "sug-2", types), false);
	assert.equal(suggestion("sug-2").status, "dismissed");
	assert.equal(await reopenSuggestionIfIdle(env, null, types), false);
});
