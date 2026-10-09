import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const bundleDirectory = makeBundleDirectory("kite-alerts-webhook-");
after(() => rmSync(bundleDirectory, { recursive: true, force: true }));
await build({
	entryPoints: [join(root, "src/lib/alerts/webhook-utils.ts")],
	outfile: join(bundleDirectory, "webhook.mjs"),
	bundle: true,
	sourcemap: "inline",
	platform: "node",
	format: "esm",
	target: "node24",
	logLevel: "silent",
});
const {
	detectWebhookKind,
	maskWebhookUrl,
	isAlertWebhookInsecureAllowed,
	validateAlertWebhookUrl,
	buildWebhookRequest,
	buildAlertMessage,
	buildTestAlertMessage,
} = await import(pathToFileURL(join(bundleDirectory, "webhook.mjs")).href);

const SENT_AT = new Date("2026-01-01T12:00:00Z");
const realMessage = (overrides = {}) => ({
	appName: "Kite",
	appUrl: "https://mail.example.com",
	alerts: [
		{ rule: "backup_failed", name: "Failed backups", count: 2, path: "/backups" },
		{ rule: "outbound_stuck", name: "Outbound messages stuck in the queue", count: 1, path: "/admin" },
	],
	sentAt: SENT_AT,
	test: false,
	...overrides,
});
const testMessage = (appUrl = "https://mail.example.com") =>
	buildTestAlertMessage({ appName: "Kite", appUrl, sentAt: SENT_AT });
const isAscii = (value) => /^[\x20-\x7e]*$/.test(value);

test("auto detection picks the kind from the host and path", () => {
	const cases = [
		["https://hooks.slack.com/services/EXAMPLE/EXAMPLE/EXAMPLE", "slack"],
		["https://HOOKS.SLACK.COM/services/EXAMPLE/EXAMPLE/EXAMPLE", "slack"],
		["https://discord.com/api/webhooks/000000/EXAMPLE", "discord"],
		["https://discordapp.com/api/webhooks/000000/EXAMPLE", "discord"],
		["https://ptb.discord.com/api/webhooks/000000/EXAMPLE", "discord"],
		["https://canary.discord.com/api/webhooks/000000/EXAMPLE", "discord"],
		["https://Canary.DiscordApp.com/api/webhooks/000000/EXAMPLE", "discord"],
		["https://discord.com/channels/1/2", "json"],
		["https://evil.discord.com/api/webhooks/000000/EXAMPLE", "json"],
		["https://ntfy.sh/example-topic", "ntfy"],
		["https://NTFY.SH/example-topic", "ntfy"],
		["https://example.com/hook", "json"],
		["https://hooks.slack.com.example.com/x", "json"],
	];
	for (const [url, kind] of cases) {
		assert.equal(detectWebhookKind(url, "auto"), kind, url);
		assert.equal(detectWebhookKind(new URL(url), "auto"), kind, url);
	}
	assert.equal(detectWebhookKind("not a url", "auto"), "json");
});

test("a non-auto setting overrides detection", () => {
	for (const kind of ["slack", "discord", "ntfy", "json"]) {
		assert.equal(detectWebhookKind("https://hooks.slack.com/services/EXAMPLE/EXAMPLE/EXAMPLE", kind), kind);
		assert.equal(detectWebhookKind("https://example.com/x", kind), kind);
	}
});

test("masking keeps only the host and port", () => {
	assert.equal(maskWebhookUrl("https://hooks.slack.com/services/EXAMPLE/EXAMPLE/EXAMPLE"), "hooks.slack.com/…");
	assert.equal(maskWebhookUrl(new URL("http://127.0.0.1:3290/hook/SECRET1")), "127.0.0.1:3290/…");
	const masked = maskWebhookUrl("https://u:p@hooks.slack.com/services/EXAMPLE/EXAMPLE/EXAMPLE?x=1#f");
	assert.equal(masked, "hooks.slack.com/…");
	for (const fragment of ["u:p", "services", "SECRET", "EXAMPLE", "x=1", "#f", "@"])
		assert.ok(!masked.includes(fragment), fragment);
	assert.equal(maskWebhookUrl("garbage"), "…");
});

test("the insecure flag works only outside production", () => {
	assert.equal(isAlertWebhookInsecureAllowed("1", undefined), true);
	assert.equal(isAlertWebhookInsecureAllowed("true", "development"), true);
	assert.equal(isAlertWebhookInsecureAllowed("1", "test"), true);
	for (const flag of [undefined, "", "0", "yes", "TRUE", "false"]) {
		assert.equal(isAlertWebhookInsecureAllowed(flag, "development"), false, String(flag));
	}
	assert.equal(isAlertWebhookInsecureAllowed("1", "production"), false);
	assert.equal(isAlertWebhookInsecureAllowed("true", "production"), false);
});

test("invalid targets are rejected with a code", () => {
	const strict = { allowInsecureLoopback: false };
	const codeOf = (raw, opts = strict) => {
		const result = validateAlertWebhookUrl(raw, opts);
		return result.ok ? "ok" : result.code;
	};
	for (const raw of ["", "   ", "not a url", "ftp://example.com/x", "javascript:alert(1)", "file:///etc/passwd"]) {
		assert.equal(codeOf(raw), "invalid_url", raw);
	}
	assert.equal(codeOf(`https://example.com/${"a".repeat(2048)}`), "invalid_url");
	assert.equal(codeOf("https://user:pw@example.com/x"), "credentials_not_allowed");
	assert.equal(codeOf("https://user@example.com/x"), "credentials_not_allowed");
	assert.equal(codeOf("http://example.com/x"), "https_required");
	for (const raw of [
		"https://10.0.0.1/",
		"https://192.168.1.1/",
		"https://172.16.0.1/",
		"https://100.64.0.1/",
		"https://169.254.169.254/",
		"https://[fe80::1]/",
		"https://metadata.google.internal/",
		"https://service.internal/",
		"https://printer.local/",
		"https://intranet/",
	]) {
		assert.equal(codeOf(raw), "blocked_host", raw);
	}
});

test("valid public https targets are accepted after trimming", () => {
	const result = validateAlertWebhookUrl("  https://hooks.slack.com/services/EXAMPLE/EXAMPLE/EXAMPLE  ", {
		allowInsecureLoopback: false,
	});
	assert.equal(result.ok, true);
	assert.equal(result.loopback, false);
	assert.equal(result.url.href, "https://hooks.slack.com/services/EXAMPLE/EXAMPLE/EXAMPLE");
	assert.equal(
		validateAlertWebhookUrl("https://ntfy.sh/example-topic", { allowInsecureLoopback: true }).loopback,
		false,
	);
});

test("loopback targets need the insecure flag", () => {
	for (const raw of ["http://127.0.0.1:3290/x", "https://localhost/x", "https://[::1]/x", "https://127.0.0.1/x"]) {
		const result = validateAlertWebhookUrl(raw, { allowInsecureLoopback: false });
		assert.equal(result.ok, false, raw);
		assert.ok(["blocked_host", "https_required"].includes(result.code), raw);
	}
	const insecure = { allowInsecureLoopback: true };
	for (const raw of [
		"http://127.0.0.1:3290/x",
		"http://127.5.5.5/x",
		"http://localhost/x",
		"http://LOCALHOST./x",
		"http://[::1]/x",
		"https://localhost/x",
	]) {
		const result = validateAlertWebhookUrl(raw, insecure);
		assert.equal(result.ok, true, raw);
		assert.equal(result.loopback, true, raw);
	}
	assert.equal(validateAlertWebhookUrl("http://example.com/x", insecure).code, "https_required");
	assert.equal(validateAlertWebhookUrl("https://192.168.1.1/", insecure).code, "blocked_host");
	assert.equal(validateAlertWebhookUrl("http://192.168.1.1/", insecure).code, "https_required");
	assert.equal(validateAlertWebhookUrl("http://u:p@127.0.0.1/x", insecure).code, "credentials_not_allowed");
});

test("slack sends the email text under one text key", () => {
	const request = buildWebhookRequest("slack", realMessage());
	assert.deepEqual(request.headers, { "content-type": "application/json" });
	const body = JSON.parse(request.body);
	assert.deepEqual(Object.keys(body), ["text"]);
	assert.equal(
		body.text,
		[
			"Kite: 2 operational alerts",
			"",
			"- Failed backups: 2",
			"  https://mail.example.com/backups",
			"- Outbound messages stuck in the queue: 1",
			"  https://mail.example.com/admin",
		].join("\n"),
	);
});

test("links are left out without an app URL and the subject is singular for one alert", () => {
	const message = realMessage({ appUrl: null, alerts: [realMessage().alerts[0]] });
	const { text } = JSON.parse(buildWebhookRequest("slack", message).body);
	assert.equal(text, "Kite: 1 operational alert\n\n- Failed backups: 2");
	assert.ok(!text.includes("http"));
	const trailing = JSON.parse(buildWebhookRequest("slack", realMessage({ appUrl: "https://mail.example.com/" })).body);
	assert.ok(trailing.text.includes("  https://mail.example.com/backups"));
});

test("discord sends content truncated to 2000 characters", () => {
	const request = buildWebhookRequest("discord", realMessage());
	assert.deepEqual(request.headers, { "content-type": "application/json" });
	const body = JSON.parse(request.body);
	assert.deepEqual(Object.keys(body), ["content"]);
	assert.ok(body.content.startsWith("Kite: 2 operational alerts\n"));
	assert.ok(body.content.includes("- Failed backups: 2\n  https://mail.example.com/backups"));

	const many = Array.from({ length: 200 }, (_, index) => ({
		rule: "outbound_failed",
		name: `Failed outbound sends ${index}`,
		count: index,
		path: "/admin",
	}));
	const long = JSON.parse(buildWebhookRequest("discord", realMessage({ alerts: many })).body);
	assert.equal(long.content.length, 2000);
	assert.ok(long.content.startsWith("Kite: 200 operational alerts\n"));
	assert.ok(long.content.endsWith("..."));
});

test("test messages use the test subject and one synthetic alert", () => {
	const { text } = JSON.parse(buildWebhookRequest("slack", testMessage()).body);
	assert.equal(text, "Kite: test alert\n\n- Test alert: 1\n  https://mail.example.com/alerts");
	const { content } = JSON.parse(buildWebhookRequest("discord", testMessage(null)).body);
	assert.equal(content, "Kite: test alert\n\n- Test alert: 1");
});

test("ntfy sends plain text with ASCII headers", () => {
	const real = buildWebhookRequest("ntfy", realMessage());
	assert.deepEqual(real.headers, {
		"content-type": "text/plain; charset=utf-8",
		Title: "Kite: 2 operational alerts",
		Priority: "high",
		Tags: "warning",
	});
	assert.equal(
		real.body,
		[
			"- Failed backups: 2",
			"  https://mail.example.com/backups",
			"- Outbound messages stuck in the queue: 1",
			"  https://mail.example.com/admin",
		].join("\n"),
	);
	const probe = buildWebhookRequest("ntfy", testMessage());
	assert.equal(probe.headers["content-type"], "text/plain; charset=utf-8");
	assert.equal(probe.headers.Title, "Kite: test alert");
	assert.equal(probe.headers.Priority, "default");
	assert.equal(probe.headers.Tags, "white_check_mark");
	assert.equal(probe.body, "- Test alert: 1\n  https://mail.example.com/alerts");
	const fancy = buildWebhookRequest("ntfy", realMessage({ appName: "Kite… Ünïcode" }));
	for (const request of [real, probe, fancy]) {
		for (const value of Object.values(request.headers)) assert.ok(isAscii(value), value);
	}
	assert.equal(fancy.headers.Title, "Kite... ?n?code: 2 operational alerts");
});

test("json sends exactly app, alerts, url and sentAt", () => {
	const real = buildWebhookRequest("json", realMessage());
	assert.deepEqual(real.headers, { "content-type": "application/json" });
	const body = JSON.parse(real.body);
	assert.deepEqual(Object.keys(body).sort(), ["alerts", "app", "sentAt", "url"]);
	assert.equal(body.app, "Kite");
	assert.equal(body.url, "https://mail.example.com");
	assert.equal(body.sentAt, "2026-01-01T12:00:00.000Z");
	assert.equal(new Date(body.sentAt).toISOString(), body.sentAt);
	assert.deepEqual(body.alerts, [
		{ rule: "backup_failed", name: "Failed backups", count: 2 },
		{ rule: "outbound_stuck", name: "Outbound messages stuck in the queue", count: 1 },
	]);
	for (const alert of body.alerts) assert.deepEqual(Object.keys(alert).sort(), ["count", "name", "rule"]);
	assert.equal(JSON.parse(buildWebhookRequest("json", realMessage({ appUrl: null })).body).url, null);

	const probe = JSON.parse(buildWebhookRequest("json", testMessage()).body);
	assert.deepEqual(Object.keys(probe).sort(), ["alerts", "app", "sentAt", "test", "url"]);
	assert.equal(probe.test, true);
	assert.deepEqual(probe.alerts, [{ rule: "test", name: "Test alert", count: 1 }]);
});

test("payloads read only rule, name, count and path from each alert", () => {
	const read = new Set();
	const tracked = (alert) =>
		new Proxy(alert, {
			get(target, key) {
				if (typeof key === "string") read.add(key);
				return target[key];
			},
		});
	const alerts = realMessage().alerts.map(tracked);
	const bodies = ["slack", "discord", "ntfy", "json"].map((kind) => {
		const request = buildWebhookRequest(kind, realMessage({ alerts }));
		return `${JSON.stringify(request.headers)}${request.body}`;
	});
	assert.deepEqual([...read].sort(), ["count", "name", "path", "rule"]);
	for (const body of bodies) {
		for (const forbidden of ["fingerprint", "@", "error", "bak_", "job_"])
			assert.ok(!body.includes(forbidden), forbidden);
	}
});

test("alert messages are built from active alerts in rule order without fingerprints", () => {
	const message = buildAlertMessage(
		[
			{ rule: "webhook_exhausted", fingerprint: "secret-fp", count: 3 },
			{ rule: "backup_failed", fingerprint: "bak_1,bak_2", count: 2 },
		],
		{ appName: "Kite", appUrl: "https://mail.example.com", sentAt: SENT_AT },
	);
	assert.deepEqual(message, {
		appName: "Kite",
		appUrl: "https://mail.example.com",
		alerts: [
			{ rule: "backup_failed", name: "Failed backups", count: 2, path: "/backups" },
			{ rule: "webhook_exhausted", name: "Webhook deliveries that ran out of retries", count: 3, path: "/webhooks" },
		],
		sentAt: SENT_AT,
		test: false,
	});
	const blank = buildAlertMessage([], { appName: "Kite", appUrl: "  ", sentAt: SENT_AT });
	assert.equal(blank.appUrl, null);
	assert.equal(buildTestAlertMessage({ appName: "Kite", appUrl: undefined, sentAt: SENT_AT }).appUrl, null);
	assert.equal(testMessage().test, true);
});
