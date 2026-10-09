import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const bundleDirectory = makeBundleDirectory("kite-alerts-rules-");
after(() => rmSync(bundleDirectory, { recursive: true, force: true }));
await build({
	entryPoints: [join(root, "src/lib/alerts/rules-utils.ts")],
	outfile: join(bundleDirectory, "rules.mjs"),
	bundle: true,
	sourcemap: "inline",
	platform: "node",
	format: "esm",
	target: "node24",
	logLevel: "silent",
});
const { ALERT_POLICY, evaluateAlertRules, decideNotifications, renderAlertEmail } = await import(
	pathToFileURL(join(bundleDirectory, "rules.mjs")).href
);

const NOW = new Date("2026-01-01T12:00:00Z");
const MIN = 60_000;
const HOUR = 60 * MIN;
const empty = {
	failedBackups: [],
	outboundFailed: 0,
	outboundStuck: 0,
	webhookExhausted: 0,
	webhookLastAttemptAt: null,
};
const baseline = (initializedAt = NOW.getTime() - 10 * HOUR) => ({ version: 1, initializedAt, rules: {} });
const rulesOf = (alerts) => alerts.map((alert) => alert.rule);

test("5 failed sends in 60 minutes alert, and 4 do not", () => {
	assert.deepEqual(evaluateAlertRules({ ...empty, outboundFailed: 4 }, NOW), []);
	assert.deepEqual(rulesOf(evaluateAlertRules({ ...empty, outboundFailed: 5 }, NOW)), ["outbound_failed"]);
});

test("stuck queued and sending jobs alert, scheduled jobs in the future do not", () => {
	assert.deepEqual(rulesOf(evaluateAlertRules({ ...empty, outboundStuck: 1 }, NOW)), ["outbound_stuck"]);
	assert.deepEqual(evaluateAlertRules({ ...empty, outboundStuck: 0 }, NOW), []);
});

test("1 exhausted webhook and a failed backup alert", () => {
	const alerts = evaluateAlertRules(
		{ ...empty, webhookExhausted: 1, webhookLastAttemptAt: 5, failedBackups: [{ id: "b", completedAt: 1 }] },
		NOW,
	);
	assert.deepEqual(rulesOf(alerts).sort(), ["backup_failed", "webhook_exhausted"]);
	assert.equal(evaluateAlertRules({ ...empty, webhookExhausted: 1 }, NOW)[0].fingerprint, "active");
});

test("the policy matches the documented thresholds", () => {
	assert.equal(ALERT_POLICY.outboundFailedThreshold, 5);
	assert.equal(ALERT_POLICY.stuckQueuedMinutes, 30);
	assert.equal(ALERT_POLICY.stuckSendingMinutes, 15);
	assert.equal(ALERT_POLICY.remindAfterHours, 24);
	assert.equal(ALERT_POLICY.minEmailIntervalMinutes, 60);
});

test("a new alert notifies once and an unchanged one stays quiet", () => {
	const active = [{ rule: "outbound_stuck", fingerprint: "active", count: 2 }];
	const first = decideNotifications(active, baseline(), NOW);
	assert.deepEqual(rulesOf(first.notify), ["outbound_stuck"]);
	assert.equal(first.nextState.lastEmailAt, NOW.getTime());
	const later = new Date(NOW.getTime() + 5 * MIN);
	const second = decideNotifications(active, first.nextState, later);
	assert.deepEqual(second.notify, []);
	assert.equal(second.nextState.rules.outbound_stuck.notifiedAt, NOW.getTime());
});

test("cooldown holds a new alert until 60 minutes after the last email", () => {
	const state = { ...baseline(), lastEmailAt: NOW.getTime(), rules: {} };
	const active = [{ rule: "backup_failed", fingerprint: "b2", count: 1 }];
	const held = decideNotifications(active, state, new Date(NOW.getTime() + 59 * MIN));
	assert.deepEqual(held.notify, []);
	assert.deepEqual(held.nextState.rules, {});
	const sent = decideNotifications(active, state, new Date(NOW.getTime() + 60 * MIN));
	assert.deepEqual(rulesOf(sent.notify), ["backup_failed"]);
});

test("a changed fingerprint notifies again after the cooldown", () => {
	const state = {
		...baseline(),
		lastEmailAt: NOW.getTime() - 2 * HOUR,
		rules: { backup_failed: { fingerprint: "b1", notifiedAt: NOW.getTime() - 2 * HOUR } },
	};
	const result = decideNotifications([{ rule: "backup_failed", fingerprint: "b1,b2", count: 2 }], state, NOW);
	assert.equal(result.notify[0].count, 2);
});

test("an unchanged alert reminds after 24 hours, not 23", () => {
	const active = [{ rule: "outbound_stuck", fingerprint: "active", count: 1 }];
	const state = {
		...baseline(0),
		lastEmailAt: NOW.getTime(),
		rules: { outbound_stuck: { fingerprint: "active", notifiedAt: NOW.getTime() } },
	};
	assert.deepEqual(decideNotifications(active, state, new Date(NOW.getTime() + 23 * HOUR)).notify, []);
	assert.deepEqual(rulesOf(decideNotifications(active, state, new Date(NOW.getTime() + 24 * HOUR)).notify), [
		"outbound_stuck",
	]);
});

test("resolve then reopen notifies again", () => {
	const active = [{ rule: "outbound_failed", fingerprint: "active", count: 6 }];
	const first = decideNotifications(active, baseline(), NOW);
	const resolved = decideNotifications([], first.nextState, new Date(NOW.getTime() + 10 * MIN));
	assert.deepEqual(resolved.nextState.rules, {});
	const reopened = decideNotifications(active, resolved.nextState, new Date(NOW.getTime() + 2 * HOUR));
	assert.deepEqual(rulesOf(reopened.notify), ["outbound_failed"]);
});

test("all due alerts are batched into one notification", () => {
	const active = [
		{ rule: "webhook_exhausted", fingerprint: "1", count: 1 },
		{ rule: "backup_failed", fingerprint: "b", count: 1 },
		{ rule: "outbound_failed", fingerprint: "active", count: 9 },
	];
	assert.equal(decideNotifications(active, baseline(), NOW).notify.length, 3);
});

test("a recent failed send attempt backs off for 60 minutes", () => {
	const state = { ...baseline(), lastAttemptAt: NOW.getTime() - 30 * MIN };
	const active = [{ rule: "backup_failed", fingerprint: "b", count: 1 }];
	assert.deepEqual(decideNotifications(active, state, NOW).notify, []);
	const after = decideNotifications(active, state, new Date(NOW.getTime() + 30 * MIN));
	assert.equal(after.notify.length, 1);
	assert.equal(after.nextState.lastAttemptAt, undefined);
});

test("the rendered email has counts and link paths but no @", () => {
	const alerts = [
		{ rule: "backup_failed", fingerprint: "val_bk1", count: 2 },
		{ rule: "webhook_exhausted", fingerprint: "1", count: 3 },
	];
	const plain = renderAlertEmail(alerts, { appName: "Kite" });
	assert.equal(plain.subject, "Kite: 2 operational alerts");
	assert.ok(!/@/.test(plain.text));
	assert.ok(!plain.text.includes("val_bk1"));
	assert.ok(plain.text.includes("Failed backups: 2"));
	const linked = renderAlertEmail(alerts.slice(0, 1), { appName: "Kite", appUrl: "https://mail.example.test/" });
	assert.equal(linked.subject, "Kite: 1 operational alert");
	assert.ok(linked.text.includes("https://mail.example.test/backups"));
	assert.ok(!/@/.test(linked.text));
});
