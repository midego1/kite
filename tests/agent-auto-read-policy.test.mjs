import assert from "node:assert/strict";
import test from "node:test";
import { collectFacts } from "../src/lib/agent/auto-read/facts-utils.ts";
import {
	allowedToExecute,
	forcesSuggest,
	matchSenderPolicy,
	planSuggestions,
} from "../src/lib/agent/auto-read/policy-utils.ts";

const LEVELS = ["off", "suggest", "act", "auto"];
const ACTIONS = [
	"create_draft",
	"move",
	"mark_read",
	"set_folder",
	"remind",
	"create_event",
	"delete_event",
	"send_rsvp",
	"send_reply",
	"unsubscribe",
	"dismiss",
];
const STATE_CHANGES = ["move", "mark_read", "set_folder", "remind"];
const CALENDAR_WRITES = ["create_event", "delete_event"];
const SENDS = ["send_rsvp", "send_reply"];

const signals = (...ids) => JSON.stringify(ids.map((id) => ({ id, score: 0, reason: id })));

function facts({ auth = true, suspicious = false, spoof = false, verdict } = {}) {
	return collectFacts({
		message: {
			fromAddr: spoof ? '"Mira Fenwick" <mira@evil.test>' : "Mira Fenwick <mira@corp.test>",
			subject: "Hello",
			textBody: "Body",
			spamVerdict: verdict ?? (suspicious ? "suspicious" : "inbox"),
			spamSignals: auth ? signals("spf_passed", "dkim_passed", "dmarc_passed") : signals("dmarc_failed"),
		},
		contacts: [{ email: "mira@corp.test", displayName: "Mira Fenwick", source: "manual" }],
	});
}

const policy = {
	pattern: "mira@corp.test",
	requireAuth: true,
	allowedActions: ["send_rsvp", "send_reply", "move"],
	templateRule: "Thanks, confirmed.",
};

function context(overrides = {}) {
	return {
		capabilities: { calendar: true, reply: true },
		fullAutoAllowed: true,
		recipient: "mira@corp.test",
		organizer: "mira@corp.test",
		rsvp: "accepted",
		hasConflict: false,
		threadAutoSendsLast24h: 0,
		...overrides,
	};
}

test("the matrix: off and suggest never change state, write the calendar or send", () => {
	const variants = [
		{ name: "auth pass", facts: facts(), policy },
		{ name: "auth fail", facts: facts({ auth: false }), policy },
		{ name: "suspicious", facts: facts({ suspicious: true }), policy },
		{ name: "not allowlisted", facts: facts(), policy: null },
	];
	for (const variant of variants)
		for (const level of ["off", "suggest"])
			for (const action of [...STATE_CHANGES, ...CALENDAR_WRITES, ...SENDS, "unsubscribe", "dismiss"]) {
				const decision = allowedToExecute(level, action, variant.facts, variant.policy, context());
				assert.equal(decision.allowed, false, `${variant.name} ${level} ${action}`);
			}
	assert.equal(allowedToExecute("off", "create_draft", facts(), policy, context()).rule, "autonomy_off");
	assert.equal(allowedToExecute("suggest", "create_draft", facts(), policy, context()).allowed, true);
	assert.equal(allowedToExecute("suggest", "move", facts(), policy, context()).rule, "suggest_disallows_move");
});

test("the matrix: act allows reversible actions only, and auto adds sends under a sender policy", () => {
	const expected = {
		act: new Set(["create_draft", ...STATE_CHANGES, "create_event"]),
		auto: new Set(["create_draft", ...STATE_CHANGES, "create_event", ...SENDS]),
	};
	for (const level of ["act", "auto"])
		for (const action of ACTIONS) {
			const decision = allowedToExecute(level, action, facts(), policy, context());
			assert.equal(decision.allowed, expected[level].has(action), `${level} ${action}: ${decision.rule}`);
		}
	for (const level of LEVELS) {
		for (const action of ["delete_event", "unsubscribe", "dismiss"])
			assert.equal(allowedToExecute(level, action, facts(), policy, context()).allowed, false);
	}
	assert.equal(allowedToExecute("auto", "send_rsvp", facts(), policy, context()).rule, "auto_allows_send_rsvp");
});

test("suspicious mail, failed auth and spoofing force Suggest", () => {
	for (const bad of [
		facts({ suspicious: true }),
		facts({ auth: false }),
		facts({ spoof: true }),
		facts({ verdict: "spam" }),
	]) {
		assert.equal(forcesSuggest(bad), true);
		for (const level of ["act", "auto"]) {
			const move = allowedToExecute(level, "move", bad, policy, context());
			assert.deepEqual([move.allowed, move.rule, move.level], [false, "suspicious_forces_suggest", "suggest"]);
			assert.equal(allowedToExecute(level, "send_rsvp", bad, policy, context()).allowed, false);
			assert.equal(allowedToExecute(level, "create_draft", bad, policy, context()).allowed, true);
		}
	}
	assert.equal(forcesSuggest(facts()), false);
	assert.equal(forcesSuggest(facts(), true), true, "a model flag can only add restrictions");
	const flagged = allowedToExecute("auto", "send_reply", facts(), policy, context({ modelFlagged: true }));
	assert.equal(flagged.rule, "suspicious_forces_suggest");
});

test("Full auto sends only to the sender or organizer, once per thread, for authenticated allowlisted senders", () => {
	const send = (overrides, options = {}) =>
		allowedToExecute(
			"auto",
			options.action ?? "send_reply",
			options.facts ?? facts(),
			options.policy ?? policy,
			context(overrides),
		);
	assert.equal(send({}).allowed, true);
	assert.equal(send({ recipient: "attacker@evil.test" }).rule, "recipient_not_sender_or_organizer");
	assert.equal(send({ recipient: undefined }).rule, "recipient_not_sender_or_organizer");
	assert.equal(send({ recipient: " MIRA@corp.test " }).allowed, true);
	const organizerSend = send({ recipient: "Mira@corp.test", organizer: " MIRA@corp.test" }, { action: "send_rsvp" });
	assert.equal(organizerSend.allowed, true, "the organizer, being the authenticated sender, may receive the RSVP");
	const otherOrganizer = send({ recipient: "boss@corp.test", organizer: "Boss@corp.test" }, { action: "send_rsvp" });
	assert.equal(otherOrganizer.rule, "organizer_not_sender", "an organizer other than the sender disables Full auto");
	const toSender = send({ recipient: "mira@corp.test", organizer: "boss@corp.test" }, { action: "send_rsvp" });
	assert.equal(toSender.rule, "organizer_not_sender");
	assert.equal(send({ recipient: "boss@corp.test", organizer: null }, { action: "send_rsvp" }).allowed, false);
	assert.equal(send({ organizer: null }, { action: "send_rsvp" }).rule, "organizer_not_sender");
	assert.equal(send({ organizer: "boss@corp.test" }).allowed, true, "replies do not depend on the organizer");
	assert.equal(send({ threadAutoSendsLast24h: 1 }).rule, "thread_send_limit");
	assert.equal(send({ fullAutoAllowed: false }).rule, "full_auto_not_allowed");
	assert.equal(send({}, { policy: { ...policy, allowedActions: ["move"] } }).rule, "action_not_in_sender_policy");
	assert.equal(send({}, { policy: { ...policy, templateRule: null } }).rule, "no_template_rule");
	assert.equal(send({}, { policy: { ...policy, templateRule: "  " } }).rule, "no_template_rule");
	assert.equal(allowedToExecute("auto", "send_reply", facts(), null, context()).rule, "sender_not_allowlisted");
	const unverified = collectFacts({
		message: { fromAddr: "mira@corp.test", subject: "", textBody: "", spamVerdict: "inbox", spamSignals: null },
	});
	assert.equal(send({}, { facts: unverified }).rule, "sender_not_authenticated", "absent signals are not verified");
	assert.equal(send({}, { facts: unverified, policy: { ...policy, requireAuth: false } }).allowed, true);
});

test("RSVPs accept only when free and decline only when busy", () => {
	const rsvp = (overrides) => allowedToExecute("auto", "send_rsvp", facts(), policy, context(overrides));
	assert.equal(rsvp({ rsvp: "accepted", hasConflict: false }).allowed, true);
	assert.equal(rsvp({ rsvp: "accepted", hasConflict: true }).rule, "rsvp_accept_conflict");
	assert.equal(rsvp({ rsvp: "declined", hasConflict: true }).allowed, true);
	assert.equal(rsvp({ rsvp: "declined", hasConflict: false }).rule, "rsvp_decline_free");
	assert.equal(rsvp({ rsvp: undefined }).rule, "rsvp_missing");
	assert.equal(
		allowedToExecute("act", "create_event", facts(), null, context({ hasConflict: true })).rule,
		"calendar_conflict",
	);
});

test("cap reached, paused, capabilities and shared mailboxes", () => {
	for (const level of ["suggest", "act", "auto"]) {
		assert.equal(
			allowedToExecute(level, "create_draft", facts(), policy, context({ capReached: true })).rule,
			"cap_reached",
		);
		assert.equal(allowedToExecute(level, "create_draft", facts(), policy, context({ paused: true })).rule, "paused");
	}
	// Shared mailboxes start with the calendar capability off.
	const shared = context({ capabilities: { calendar: false, reply: true } });
	assert.equal(allowedToExecute("act", "create_event", facts(), policy, shared).rule, "capability_calendar_off");
	assert.equal(allowedToExecute("auto", "send_rsvp", facts(), policy, shared).rule, "capability_calendar_off");
	assert.equal(allowedToExecute("act", "move", facts(), policy, shared).allowed, true);
	const enabled = context({ capabilities: { calendar: true, reply: true } });
	assert.equal(allowedToExecute("act", "create_event", facts(), policy, enabled).allowed, true);
	const noReply = context({ capabilities: { calendar: true, reply: false } });
	assert.equal(allowedToExecute("suggest", "create_draft", facts(), policy, noReply).rule, "capability_reply_off");
	assert.equal(allowedToExecute("auto", "send_reply", facts(), policy, noReply).rule, "capability_reply_off");
});

test("sender policies match an exact address before a domain", () => {
	const policies = [{ pattern: "@corp.test" }, { pattern: "Mira@Corp.test" }];
	assert.equal(matchSenderPolicy(policies, "mira@corp.test")?.pattern, "Mira@Corp.test");
	assert.equal(matchSenderPolicy(policies, "alan@corp.test")?.pattern, "@corp.test");
	assert.equal(matchSenderPolicy(policies, "alan@sub.corp.test"), null);
	assert.equal(matchSenderPolicy(policies, "not-an-address"), null);
});

const capabilities = {
	calendar: true,
	reply: true,
	summary: true,
	phishing: true,
	mutedSenders: [],
	trustedSenders: [],
};
const settings = (overrides = {}) => ({
	capabilities,
	canDraftReply: true,
	filed: false,
	threadMessageCount: 1,
	...overrides,
});
const triage = (overrides = {}) => ({
	category: "needs_reply",
	needsReply: true,
	urgency: "low",
	summary: "Asks for the report.",
	tasks: [],
	suspicious: { flagged: false, reasons: [] },
	...overrides,
});
const kinds = (planned) => planned.map((item) => item.kind);

test("planSuggestions: reply drafts need a reply-worthy, unfiled, clean message and send permission", () => {
	const reply = planSuggestions({ facts: facts(), triage: triage(), settings: settings() });
	assert.deepEqual(reply, [{ kind: "reply", payload: { urgency: "low" }, reason: "needs_reply", autoExecute: false }]);
	assert.deepEqual(
		kinds(planSuggestions({ facts: facts(), triage: triage({ needsReply: false }), settings: settings() })),
		[],
	);
	assert.deepEqual(
		kinds(planSuggestions({ facts: facts(), triage: triage(), settings: settings({ filed: true }) })),
		[],
	);
	assert.deepEqual(
		kinds(planSuggestions({ facts: facts(), triage: triage(), settings: settings({ canDraftReply: false }) })),
		[],
	);
	const off = settings({ capabilities: { ...capabilities, reply: false } });
	assert.deepEqual(kinds(planSuggestions({ facts: facts(), triage: triage(), settings: off })), []);
	const bulk = collectFacts({
		message: { fromAddr: "news@x.test", subject: "", textBody: "", spamVerdict: "inbox", spamSignals: null },
		headers: { "List-Id": "x" },
	});
	assert.deepEqual(kinds(planSuggestions({ facts: bulk, triage: triage(), settings: settings() })), []);
	assert.deepEqual(kinds(planSuggestions({ facts: facts(), triage: null, settings: settings() })), []);
	assert.ok(
		planSuggestions({ facts: facts(), triage: triage(), settings: settings() }).every(
			(item) => item.autoExecute === false,
		),
	);
});

test("planSuggestions: phishing forces Suggest, suppresses the reply, and model reasons only add to a confirmed warning", () => {
	const deterministic = planSuggestions({ facts: facts({ suspicious: true }), triage: triage(), settings: settings() });
	assert.deepEqual(kinds(deterministic), ["phishing"]);
	assert.deepEqual(deterministic[0].payload.reasons, ["suspicious_verdict"]);

	const cleared = planSuggestions({
		facts: facts({ suspicious: true }),
		triage: triage({ suspicious: { flagged: false, reasons: [] } }),
		settings: settings(),
	});
	assert.deepEqual(cleared[0].payload.reasons, ["suspicious_verdict"], "the model cannot clear a deterministic reason");

	const unconfirmed = planSuggestions({
		facts: facts(),
		triage: triage({ suspicious: { flagged: true, reasons: ["credential_request", "urgency_pressure"] } }),
		settings: settings(),
	});
	assert.deepEqual(kinds(unconfirmed), [], "a model flag alone warns about nothing but still blocks the reply");

	const unflaggedReasons = planSuggestions({
		facts: facts(),
		triage: triage({ suspicious: { flagged: false, reasons: ["credential_request"] } }),
		settings: settings(),
	});
	assert.deepEqual(kinds(unflaggedReasons), ["reply"], "reasons without the flag add nothing");

	const confirmed = planSuggestions({
		facts: facts({ suspicious: true }),
		triage: triage({ suspicious: { flagged: true, reasons: ["credential_request", "urgency_pressure"] } }),
		settings: settings(),
	});
	assert.deepEqual(confirmed[0].payload.reasons, ["suspicious_verdict", "credential_request", "urgency_pressure"]);
	const flaggedAndSuspicious = planSuggestions({
		facts: facts({ suspicious: true }),
		triage: triage({ suspicious: { flagged: true, reasons: [] } }),
		settings: settings(),
	});
	assert.deepEqual(flaggedAndSuspicious[0].payload.reasons, ["suspicious_verdict", "model_flagged"]);
	const capabilityOff = settings({ capabilities: { ...capabilities, phishing: false } });
	assert.deepEqual(
		kinds(planSuggestions({ facts: facts({ spoof: true }), triage: triage(), settings: capabilityOff })),
		[],
	);
});

test("planSuggestions: summaries need three messages or a long body", () => {
	assert.deepEqual(
		kinds(
			planSuggestions({
				facts: facts(),
				triage: triage({ needsReply: false }),
				settings: settings({ threadMessageCount: 3 }),
			}),
		),
		["summary"],
	);
	assert.deepEqual(
		planSuggestions({
			facts: facts(),
			triage: triage({ needsReply: false }),
			settings: settings({ threadMessageCount: 2 }),
		}),
		[],
	);
	const long = { ...facts(), bodyLength: 1_501 };
	const planned = planSuggestions({ facts: long, triage: triage({ needsReply: false }), settings: settings() });
	assert.deepEqual(planned, [
		{ kind: "summary", payload: { text: "Asks for the report." }, reason: "long_thread", autoExecute: false },
	]);
	assert.deepEqual(
		kinds(
			planSuggestions({
				facts: { ...facts(), bodyLength: 1_500 },
				triage: triage({ needsReply: false }),
				settings: settings(),
			}),
		),
		[],
	);
	const empty = triage({ needsReply: false, summary: "  " });
	assert.deepEqual(kinds(planSuggestions({ facts: long, triage: empty, settings: settings() })), []);
	const off = settings({ capabilities: { ...capabilities, summary: false } });
	assert.deepEqual(kinds(planSuggestions({ facts: long, triage: triage({ needsReply: false }), settings: off })), []);
});

test("planSuggestions: module suggestions, muted senders", () => {
	const moduleSuggestions = [
		{ kind: "calendar_invite", payload: { uid: "u1" }, reason: "calendar_invite", autoExecute: false },
	];
	assert.deepEqual(kinds(planSuggestions({ facts: facts(), triage: null, settings: settings(), moduleSuggestions })), [
		"calendar_invite",
	]);
	const muted = settings({ capabilities: { ...capabilities, mutedSenders: ["mira@corp.test", "mira@evil.test"] } });
	assert.deepEqual(
		kinds(planSuggestions({ facts: facts(), triage: triage(), settings: muted, moduleSuggestions })),
		[],
	);
	assert.deepEqual(kinds(planSuggestions({ facts: facts({ spoof: true }), triage: triage(), settings: muted })), [
		"phishing",
	]);
});

test("planSuggestions: each failed SPF, DKIM or DMARC check is a phishing reason and suppresses the reply", () => {
	for (const failed of ["spf_failed", "dkim_failed", "dmarc_failed"]) {
		const failing = collectFacts({
			message: {
				fromAddr: "Mira Fenwick <mira@corp.test>",
				subject: "Hello",
				textBody: "Body",
				spamVerdict: "inbox",
				spamSignals: signals(failed),
			},
		});
		const planned = planSuggestions({
			facts: failing,
			triage: triage({ suspicious: { flagged: false, reasons: [] } }),
			settings: settings(),
		});
		assert.deepEqual(kinds(planned), ["phishing"], failed);
		assert.deepEqual(planned[0].payload.reasons, [failed]);
	}
});
