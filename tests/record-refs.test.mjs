import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { bundleModules } from "./support/modules-bundle.mjs";
import { migrationsDir, seedAccountData, seedBookingAppointment } from "./support/module-database.mjs";

const {
	SqliteDatabase,
	applyMigrations,
	parseRecordKind,
	parseRecordRef,
	formatRecordRef,
	isSameOriginPath,
	neutralRefLabel,
	refTarget,
	createRefResolver,
	resolveRecordRefs,
	clearModuleStateCache,
	MODULE_MANIFESTS,
} = await bundleModules("kite-record-refs-", [
	["SqliteDatabase", "server/runtime/sqlite-database.ts"],
	["applyMigrations", "server/runtime/migrate.ts"],
	[
		"parseRecordKind, parseRecordRef, formatRecordRef, neutralRefLabel, refTarget, createRefResolver",
		"src/lib/modules/record-ref-utils.ts",
	],
	["isSameOriginPath", "src/lib/modules/path-utils.ts"],
	["resolveRecordRefs", "src/lib/modules/record-refs.ts"],
	["clearModuleStateCache", "src/lib/modules/state.ts"],
	["MODULE_MANIFESTS", "src/lib/modules/registry.ts"],
]);

const VIEWER = { userId: "owner", role: "user", isPrimaryAdmin: false };
const OTHER = { userId: "member", role: "user", isPrimaryAdmin: false };
const ADMIN = { userId: "owner", role: "admin", isPrimaryAdmin: true };

afterEach(() => {
	delete globalThis.__kiteNodeEnv;
	clearModuleStateCache();
});

test("record kinds are <namespace>:<type> and refs parse and format round trip", () => {
	assert.deepEqual(parseRecordKind("calendar:event"), { namespace: "calendar", type: "event" });
	assert.equal(parseRecordKind("calendar"), null);
	assert.equal(parseRecordKind("calendar:event:extra"), null);
	assert.equal(parseRecordKind("Calendar:Event"), null);
	assert.equal(parseRecordKind("nope:thing"), null);
	assert.equal(parseRecordKind(7), null);
	assert.deepEqual(parseRecordRef("calendar:event:evt_1"), { kind: "calendar:event", id: "evt_1" });
	assert.deepEqual(parseRecordRef("mail:message:a:b:c"), { kind: "mail:message", id: "a:b:c" });
	assert.equal(parseRecordRef("calendar:event:"), null);
	assert.equal(parseRecordRef("calendar:event"), null);
	assert.equal(parseRecordRef("unknown:kind:1"), null);
	assert.equal(parseRecordRef(""), null);
	const ref = { kind: "booking:appointment", id: "evt-9" };
	assert.equal(formatRecordRef(ref), "booking:appointment:evt-9");
	assert.deepEqual(parseRecordRef(formatRecordRef(ref)), ref);
});

test("every manifest record kind is a known kind with a neutral label", () => {
	for (const manifest of MODULE_MANIFESTS)
		for (const { kind, unavailableLabel } of manifest.recordKinds) {
			assert.notEqual(parseRecordKind(kind), null, kind);
			assert.equal(neutralRefLabel(kind), unavailableLabel);
		}
	assert.equal(neutralRefLabel("calendar:event"), "Calendar event");
	assert.equal(neutralRefLabel("booking:event_type"), "Booking");
	assert.equal(neutralRefLabel("booking:appointment"), "Booking");
	assert.equal(neutralRefLabel("templates:template"), "Template");
	assert.equal(neutralRefLabel("import:job"), "Import");
	assert.equal(neutralRefLabel("mail:message"), "Message");
	assert.equal(neutralRefLabel("contact:contact"), "Contact");
});

test("isSameOriginPath accepts a single leading slash only", () => {
	for (const ok of ["/", "/inbox", "/calendar?date=2026-10-12&event=evt_1", "/settings/import", "/inbox/a%2Fb"])
		assert.equal(isSameOriginPath(ok), true, ok);
	for (const bad of [
		"//evil.example",
		"//",
		"/\\evil.example",
		"/\t/evil.example",
		"/\n/evil.example",
		"https://evil.example",
		"http://evil.example/x",
		"javascript:alert(1)",
		"data:text/html,x",
		"inbox",
		"./inbox",
		"",
		" /inbox",
		null,
		undefined,
		7,
		{},
	])
		assert.equal(isSameOriginPath(bad), false, String(bad));
});

test("a ref with no href, an unavailable ref and an unsafe href are all drawn as text", () => {
	assert.deepEqual(refTarget({ kind: "calendar:event", id: "e", href: "/calendar?event=e", label: "Review" }), {
		href: "/calendar?event=e",
		label: "Review",
	});
	assert.deepEqual(refTarget({ kind: "templates:template", id: "t", href: null, label: "Welcome" }), {
		href: null,
		label: "Welcome",
	});
	assert.deepEqual(refTarget({ kind: "calendar:event", id: "e", unavailable: true, label: "Calendar event" }), {
		href: null,
		label: "Calendar event",
	});
	assert.deepEqual(refTarget({ kind: "calendar:event", id: "e", href: "//evil.example", label: "Review" }), {
		href: null,
		label: "Review",
	});
});

function fakeDeps(overrides = {}) {
	const calls = { core: [], module: [] };
	const deps = {
		resolveCore: async (viewer, kind, ids) => {
			calls.core.push({ viewer, kind, ids });
			return ids.map((id) => ({ kind, id, href: `/${id}`, label: `Core ${id}` }));
		},
		invokeModule: async (moduleId, refs) => {
			calls.module.push({ moduleId, refs });
			return refs.map((ref) => ({ ...ref, href: `/${ref.id}`, label: `Title ${ref.id}` }));
		},
		...overrides,
	};
	return { calls, resolve: createRefResolver(deps) };
}

test("refs are batched once per owning module and once per core kind, in input order", async () => {
	const { calls, resolve } = fakeDeps();
	const results = await resolve(VIEWER, [
		{ kind: "calendar:event", id: "e1" },
		{ kind: "booking:event_type", id: "b1" },
		{ kind: "calendar:event", id: "e2" },
		{ kind: "calendar:event", id: "e1" },
		{ kind: "booking:appointment", id: "a1" },
		{ kind: "mail:message", id: "m1" },
		{ kind: "mail:message", id: "m2" },
	]);
	assert.deepEqual(
		results.map((result) => `${result.kind}:${result.id}:${result.label}`),
		[
			"calendar:event:e1:Title e1",
			"booking:event_type:b1:Title b1",
			"calendar:event:e2:Title e2",
			"calendar:event:e1:Title e1",
			"booking:appointment:a1:Title a1",
			"mail:message:m1:Core m1",
			"mail:message:m2:Core m2",
		],
	);
	assert.deepEqual(
		calls.module.map((call) => [call.moduleId, call.refs.map((ref) => ref.id)]),
		[
			["calendar", ["e1", "e2"]],
			["booking", ["b1", "a1"]],
		],
	);
	assert.deepEqual(
		calls.core.map((call) => [call.kind, call.ids]),
		[["mail:message", ["m1", "m2"]]],
	);
});

test("more refs than one call takes are split, never dropped", async () => {
	const { calls, resolve } = fakeDeps();
	const refs = Array.from({ length: 230 }, (_, index) => ({ kind: "calendar:event", id: `e${index}` }));
	const results = await resolve(VIEWER, refs);
	assert.equal(results.length, 230);
	assert.equal(
		results.every((result) => !result.unavailable),
		true,
	);
	assert.deepEqual(
		calls.module.map((call) => call.refs.length),
		[100, 100, 30],
	);
});

test("a failed or disabled resolver gives unavailable refs with neutral labels and no title", async () => {
	const { resolve } = fakeDeps({ invokeModule: async () => null });
	const results = await resolve(VIEWER, [
		{ kind: "calendar:event", id: "e1" },
		{ kind: "booking:event_type", id: "b1" },
		{ kind: "templates:template", id: "t1" },
		{ kind: "import:job", id: "j1" },
	]);
	assert.deepEqual(
		results.map((result) => [result.unavailable, result.label, "href" in result]),
		[
			[true, "Calendar event", false],
			[true, "Booking", false],
			[true, "Template", false],
			[true, "Import", false],
		],
	);
});

test("a thrown core resolver makes only its own kind unavailable", async () => {
	const { resolve } = fakeDeps({
		resolveCore: async (_viewer, kind, ids) => {
			if (kind === "mail:thread") throw new Error("database is locked: secret subject");
			return ids.map((id) => ({ kind, id, href: "/inbox", label: "Hello" }));
		},
	});
	const results = await resolve(VIEWER, [
		{ kind: "mail:thread", id: "t1" },
		{ kind: "mail:message", id: "m1" },
	]);
	assert.deepEqual(results[0], { kind: "mail:thread", id: "t1", unavailable: true, label: "Conversation" });
	assert.equal(results[1].label, "Hello");
});

test("a resolver that returns an unsafe href yields an unavailable ref, never a link", async () => {
	for (const href of [
		"//evil.example",
		"https://evil.example",
		"javascript:alert(1)",
		"data:text/html,x",
		"inbox",
		"",
	]) {
		const { resolve } = fakeDeps({
			invokeModule: async (_moduleId, refs) => refs.map((ref) => ({ ...ref, href, label: "Secret title" })),
			resolveCore: async (_viewer, kind, ids) => ids.map((id) => ({ kind, id, href, label: "Secret subject" })),
		});
		const results = await resolve(VIEWER, [
			{ kind: "calendar:event", id: "e1" },
			{ kind: "mail:message", id: "m1" },
		]);
		for (const result of results) {
			assert.equal(result.unavailable, true, `${href} for ${result.kind}`);
			assert.equal("href" in result, false);
			assert.doesNotMatch(result.label, /Secret/);
		}
	}
});

test("results that were not asked for, or carry no label, never leak through", async () => {
	const { resolve } = fakeDeps({
		invokeModule: async () => [
			{ kind: "calendar:event", id: "other", href: "/x", label: "Not requested" },
			{ kind: "calendar:event", id: "e1", href: "/x", label: "   " },
			{ kind: "calendar:event", id: "e2", unavailable: true, label: "Private board meeting" },
		],
	});
	const results = await resolve(VIEWER, [
		{ kind: "calendar:event", id: "e1" },
		{ kind: "calendar:event", id: "e2" },
		{ kind: "calendar:event", id: "e3" },
	]);
	assert.deepEqual(
		results.map((result) => [result.id, result.unavailable, result.label]),
		[
			["e1", true, "Calendar event"],
			["e2", true, "Calendar event"],
			["e3", true, "Calendar event"],
		],
	);
});

test("contact refs are reserved and unresolvable, and a signed-out viewer resolves nothing", async () => {
	const { calls, resolve } = fakeDeps();
	const [contact] = await resolve(VIEWER, [{ kind: "contact:contact", id: "c1" }]);
	assert.deepEqual(contact, { kind: "contact:contact", id: "c1", unavailable: true, label: "Contact" });
	assert.equal(calls.core.length + calls.module.length, 0);
	const none = await resolve(null, [
		{ kind: "mail:message", id: "m1" },
		{ kind: "calendar:event", id: "e1" },
	]);
	assert.deepEqual(
		none.map((result) => [result.unavailable, result.label]),
		[
			[true, "Message"],
			[true, "Calendar event"],
		],
	);
	assert.equal(calls.core.length + calls.module.length, 0);
});

test("an unknown kind is unavailable with a generic label", async () => {
	const { resolve } = fakeDeps();
	const [result] = await resolve(VIEWER, [{ kind: "nope:thing", id: "x" }]);
	assert.deepEqual(result, { kind: "nope:thing", id: "x", unavailable: true, label: "Record" });
});

async function database(t) {
	const db = new SqliteDatabase(":memory:");
	t.after(() => db.db.close());
	await applyMigrations(db, migrationsDir);
	seedAccountData(db);
	seedBookingAppointment(db);
	db.db.exec(`
		INSERT INTO import_jobs (id, user_id, mailbox_id, label, destination, host, port, username, folder, status, created_at, updated_at)
			VALUES ('job-1', 'owner', 'mailbox-a', 'Old provider', 'inbox', 'imap.example.com', 993, 'someone', 'INBOX', 'completed', 1, 1);
		INSERT INTO messages (id, user_id, mailbox_id, direction, from_addr, to_addr, subject, status, thread_id, created_at)
			VALUES ('draft-1', 'owner', 'mailbox-a', 'outbound', 'a@example.com', 'x@example.net', 'Secret draft', 'draft', 'thread-d', 4);
	`);
	globalThis.__kiteNodeEnv = { DB: db };
	return db;
}

const resolveOne = async (viewer, kind, id) =>
	(await resolveRecordRefs(globalThis.__kiteNodeEnv, viewer, [{ kind, id }]))[0];

test("every kind resolves to a same-origin link and label for a viewer who can see the record", async (t) => {
	const db = await database(t);
	db.db.exec("UPDATE users SET role = 'admin' WHERE id = 'owner'");
	const refs = [
		{ kind: "mail:message", id: "message-1" },
		{ kind: "mail:thread", id: "thread-1" },
		{ kind: "mail:mailbox", id: "mailbox-a" },
		{ kind: "user:user", id: "member" },
		{ kind: "calendar:event", id: "event-1" },
		{ kind: "templates:template", id: "template-1" },
		{ kind: "import:job", id: "job-1" },
	];
	const results = await resolveRecordRefs(globalThis.__kiteNodeEnv, ADMIN, refs);
	const shown = Object.fromEntries(results.map((result) => [result.kind, [result.href, result.label]]));
	assert.deepEqual(shown, {
		"mail:message": ["/inbox/message-1", "Question"],
		"mail:thread": ["/inbox/message-1", "Question"],
		"mail:mailbox": ["/inbox", "a@example.com"],
		"user:user": ["/accounts/member", "Member"],
		"calendar:event": ["/calendar?date=1970-01-01&event=event-1", "Café review"],
		"templates:template": [null, "Welcome"],
		"import:job": ["/settings/import", "Old provider (completed)"],
	});
	for (const result of results) assert.equal(result.unavailable, undefined, result.kind);
	for (const result of results) if (result.href !== null) assert.equal(isSameOriginPath(result.href), true);

	const member = await resolveRecordRefs(globalThis.__kiteNodeEnv, OTHER, [
		{ kind: "booking:event_type", id: "type-1" },
		{ kind: "booking:appointment", id: "event-2" },
		{ kind: "calendar:event", id: "event-2" },
	]);
	assert.deepEqual(
		member.map((result) => [result.kind, result.href, result.label]),
		[
			["booking:event_type", "/booking?event=type-1", "Intro"],
			["booking:appointment", "/calendar?date=1970-01-01&event=event-2", "Booked: Booked call"],
			["calendar:event", "/calendar?date=1970-01-01&event=event-2", "Booked call"],
		],
	);
});

test("the calendar day follows the viewer's time zone", async (t) => {
	const db = await database(t);
	db.db.exec("UPDATE calendar_events SET starts_at = 1791806400 WHERE id = 'event-1'");
	const [utc] = await resolveRecordRefs(globalThis.__kiteNodeEnv, VIEWER, [{ kind: "calendar:event", id: "event-1" }], {
		timeZone: "UTC",
	});
	const [auckland] = await resolveRecordRefs(
		globalThis.__kiteNodeEnv,
		VIEWER,
		[{ kind: "calendar:event", id: "event-1" }],
		{ timeZone: "Pacific/Auckland" },
	);
	assert.equal(utc.href, "/calendar?date=2026-10-12&event=event-1");
	assert.equal(auckland.href, "/calendar?date=2026-10-13&event=event-1");
});

test("another user's records are unavailable with neutral labels and no title", async (t) => {
	const db = await database(t);
	db.db.exec(
		"INSERT INTO users (id, email, password_hash, name, created_at) VALUES ('stranger', 's@example.com', 'hash', 'Stranger', 1)",
	);
	const stranger = { userId: "stranger", role: "user", isPrimaryAdmin: false };
	const foreign = [
		{ kind: "calendar:event", id: "event-1" },
		{ kind: "calendar:event", id: "event-2" },
		{ kind: "booking:event_type", id: "type-1" },
		{ kind: "booking:appointment", id: "event-2" },
		{ kind: "templates:template", id: "template-1" },
		{ kind: "import:job", id: "job-1" },
		{ kind: "mail:message", id: "message-1" },
		{ kind: "mail:thread", id: "thread-1" },
		{ kind: "mail:mailbox", id: "mailbox-a" },
		{ kind: "user:user", id: "owner" },
	];
	const results = await resolveRecordRefs(globalThis.__kiteNodeEnv, stranger, foreign);
	assert.deepEqual(
		results.map((result) => [result.kind, result.unavailable, result.label]),
		[
			["calendar:event", true, "Calendar event"],
			["calendar:event", true, "Calendar event"],
			["booking:event_type", true, "Booking"],
			["booking:appointment", true, "Booking"],
			["templates:template", true, "Template"],
			["import:job", true, "Import"],
			["mail:message", true, "Message"],
			["mail:thread", true, "Conversation"],
			["mail:mailbox", true, "Mailbox"],
			["user:user", true, "User"],
		],
	);
	assert.doesNotMatch(JSON.stringify(results), /Café|Booked call|Intro|Welcome|Old provider|Question|Owner|a@example/);
});

test("another user's calendar event, event type and appointment never show their title", async (t) => {
	await database(t);
	const env = globalThis.__kiteNodeEnv;
	const calendarEvent = await resolveOne(VIEWER, "calendar:event", "event-2");
	const eventType = await resolveOne(VIEWER, "booking:event_type", "type-1");
	const appointment = await resolveOne(VIEWER, "booking:appointment", "event-2");
	assert.deepEqual(calendarEvent, {
		kind: "calendar:event",
		id: "event-2",
		unavailable: true,
		label: "Calendar event",
	});
	assert.deepEqual(eventType, { kind: "booking:event_type", id: "type-1", unavailable: true, label: "Booking" });
	assert.deepEqual(appointment, { kind: "booking:appointment", id: "event-2", unavailable: true, label: "Booking" });
	const serialized = JSON.stringify(
		await resolveRecordRefs(env, VIEWER, [
			{ kind: "calendar:event", id: "event-2" },
			{ kind: "booking:event_type", id: "type-1" },
			{ kind: "booking:appointment", id: "event-2" },
		]),
	);
	assert.doesNotMatch(serialized, /Booked call|Intro/);
});

test("a calendar event that is not an appointment is not a booking:appointment", async (t) => {
	await database(t);
	const result = await resolveOne(VIEWER, "booking:appointment", "event-1");
	assert.equal(result.unavailable, true);
	assert.equal(result.label, "Booking");
});

test("missing records, drafts of others and module-owned rows are unavailable", async (t) => {
	await database(t);
	for (const [kind, id, label] of [
		["calendar:event", "gone", "Calendar event"],
		["booking:event_type", "gone", "Booking"],
		["import:job", "gone", "Import"],
		["templates:template", "message-1", "Template"],
		["mail:message", "gone", "Message"],
		["mail:message", "template-1", "Message"],
	]) {
		const result = await resolveOne(VIEWER, kind, id);
		assert.deepEqual([result.unavailable, result.label], [true, label], `${kind} ${id}`);
	}
	const ownDraft = await resolveOne(VIEWER, "mail:message", "draft-1");
	assert.equal(ownDraft.href, "/drafts/draft-1");
	globalThis.__kiteNodeEnv.DB.db.exec("UPDATE messages SET user_id = 'member' WHERE id = 'draft-1'");
	const others = await resolveOne(VIEWER, "mail:message", "draft-1");
	assert.deepEqual([others.unavailable, others.label], [true, "Message"]);
});

test("shared mailboxes resolve for members with access and not for others", async (t) => {
	const db = await database(t);
	db.db.exec(`
		UPDATE mailboxes SET type = 'shared' WHERE id = 'mailbox-a';
		INSERT INTO mailbox_access (id, mailbox_id, user_id, permission, created_at) VALUES ('acc-1', 'mailbox-a', 'member', 'read_only', 1);
	`);
	const viaAccess = await resolveOne(OTHER, "mail:message", "message-1");
	assert.deepEqual([viaAccess.href, viaAccess.label], ["/inbox/message-1", "Question"]);
	db.db.exec("DELETE FROM mailbox_access");
	assert.equal((await resolveOne(OTHER, "mail:message", "message-1")).unavailable, true);
	db.db.exec("UPDATE mailboxes SET disabled = 1");
	assert.equal((await resolveOne(VIEWER, "mail:message", "message-1")).unavailable, true);
});

test("the owner of a message sees its folder, and other users are not shown another account", async (t) => {
	const db = await database(t);
	db.db.exec("UPDATE messages SET status = 'spam' WHERE id = 'message-1'");
	assert.equal((await resolveOne(VIEWER, "mail:message", "message-1")).href, "/spam/message-1");
	const self = await resolveOne(VIEWER, "user:user", "owner");
	assert.deepEqual([self.href, self.label], [null, "Owner"]);
	assert.equal((await resolveOne(VIEWER, "user:user", "member")).unavailable, true);
});

test("a module that is off for the viewer resolves to unavailable, and resolves again when on", async (t) => {
	const db = await database(t);
	const calendarOn = await resolveOne(VIEWER, "calendar:event", "event-1");
	assert.equal(calendarOn.label, "Café review");
	db.db.exec("UPDATE module_settings SET enabled = 0 WHERE module_id = 'calendar'");
	clearModuleStateCache();
	const results = await resolveRecordRefs(globalThis.__kiteNodeEnv, VIEWER, [
		{ kind: "calendar:event", id: "event-1" },
		{ kind: "templates:template", id: "template-1" },
		{ kind: "booking:event_type", id: "type-1" },
	]);
	assert.deepEqual(
		results.map((result) => [result.kind, result.unavailable === true, result.label]),
		[
			["calendar:event", true, "Calendar event"],
			["templates:template", false, "Welcome"],
			["booking:event_type", true, "Booking"],
		],
	);
	db.db.exec("UPDATE module_settings SET enabled = 1 WHERE module_id = 'calendar'");
	db.db.exec(
		"INSERT INTO user_module_access (id, user_id, module_id, allowed, updated_at) VALUES ('a1', 'owner', 'templates', 0, 1)",
	);
	clearModuleStateCache();
	const restricted = await resolveOne(VIEWER, "templates:template", "template-1");
	assert.deepEqual([restricted.unavailable, restricted.label], [true, "Template"]);
	assert.equal((await resolveOne(VIEWER, "calendar:event", "event-1")).label, "Café review");
});

test("a failing database makes module refs unavailable instead of throwing", async (t) => {
	await database(t);
	globalThis.__kiteNodeEnv = {
		DB: {
			prepare() {
				throw new Error("D1_ERROR: network connection lost");
			},
		},
	};
	const results = await resolveRecordRefs(globalThis.__kiteNodeEnv, VIEWER, [
		{ kind: "calendar:event", id: "event-1" },
		{ kind: "mail:message", id: "message-1" },
	]);
	assert.deepEqual(
		results.map((result) => [result.unavailable, result.label]),
		[
			[true, "Calendar event"],
			[true, "Message"],
		],
	);
});

test("a viewer without the module's read grant gets unavailable refs", async (t) => {
	await database(t);
	const [result] = await resolveRecordRefs(
		globalThis.__kiteNodeEnv,
		VIEWER,
		[{ kind: "calendar:event", id: "event-1" }],
		{
			grants: ["templates.read"],
		},
	);
	assert.deepEqual([result.unavailable, result.label], [true, "Calendar event"]);
});
