import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const directory = makeBundleDirectory("kite-manual-dns-test-");
after(() => rmSync(directory, { recursive: true, force: true }));

/** `getResendReceivingView`'s own dependencies, stubbed so the test never touches a real D1 or Resend account. */
const resendDepsStub = {
	"drizzle-orm": "export const eq = (column, value) => ({ column, value });",
	"@/db/schema": `export const appSettings = { id: "appSettings.id", resendWebhookSecret: "appSettings.resendWebhookSecret" };`,
	"@/db": `const query = {
			from() { return query; },
			where() { return query; },
			limit() { return Promise.resolve(globalThis.__kiteResendSettingsRows ?? []); },
		};
		export function getDb() {
			return {
				select() { return query; },
				insert() { return { values() { return { onConflictDoUpdate() { return Promise.resolve(); } }; } }; },
			};
		}`,
	"@/lib/security/secret-box": `export async function openSetting(_env, value) { return value ?? null; }
		export async function sealSetting(_env, value) { return value ?? null; }`,
	"@/lib/email/outbound-provider": `export async function getResendApiKey() { return "re_test"; }
		export async function getResendKeyStatus() {
			return globalThis.__kiteResendKey ?? { configured: false, apiKey: null, source: null };
		}`,
	"@/lib/email/resend-api": `export class ResendRestrictedKeyError extends Error {}
		export async function findResendDomain() { return globalThis.__kiteResendDomain ?? null; }
		export async function getResendDomain() { return globalThis.__kiteResendDomain ?? null; }
		export async function listResendWebhooks() { return globalThis.__kiteResendWebhooks ?? []; }
		export async function createResendDomain() { return { id: "rd1" }; }
		export async function createResendWebhook() { return { id: "w1", signing_secret: "s" }; }
		export async function deleteResendDomain() {}
		export async function deleteResendWebhook() {}
		export async function updateResendCapabilities() {}
		export async function verifyResendDomain() {}`,
};

const resendDepsPlugin = {
	name: "resend-deps-stub",
	setup(builder) {
		const names = Object.keys(resendDepsStub)
			.map((name) => name.replace(/[/.-]/g, "\\$&"))
			.join("|");
		builder.onResolve({ filter: new RegExp(`^(${names})$`) }, (args) => ({ path: args.path, namespace: "stub" }));
		builder.onLoad({ filter: /.*/, namespace: "stub" }, (args) => ({
			contents: resendDepsStub[args.path],
			loader: "js",
		}));
	},
};

await build({
	stdin: {
		contents: `
			export { hasMx, hasMxMatching, isInboundSmtpMx, MX_UNCHECKED } from "./src/lib/domains/receiving-dns.ts";
			export { auditDomainDns } from "./src/lib/domains/dns-audit.ts";
			export { MANUAL_ZONE_ID } from "./src/lib/domains/provision.ts";
			export { getResendReceivingView } from "./src/lib/domains/resend-receiving.ts";
		`,
		resolveDir: root,
		sourcefile: "manual-dns-test-entry.ts",
	},
	outfile: join(directory, "entry.mjs"),
	bundle: true,
	sourcemap: "inline",
	absWorkingDir: root,
	platform: "node",
	format: "esm",
	target: "node24",
	tsconfig: join(root, "tsconfig.json"),
	packages: "external",
	alias: {
		"next/headers": "next/headers.js",
		"next/server": "next/server.js",
		"cloudflare:workers": "./server/runtime/cloudflare-workers.ts",
	},
	plugins: [resendDepsPlugin],
	logLevel: "silent",
});
const m = await import(pathToFileURL(join(directory, "entry.mjs")).href);

const manualDomain = { hostname: "example.com", zoneId: m.MANUAL_ZONE_ID };

/** Answers DNS-over-HTTPS lookups from `answers` ("name|TYPE" to data strings); anything else is NXDOMAIN. */
function answerDns(t, answers) {
	const asked = [];
	t.mock.method(globalThis, "fetch", async (url) => {
		const parsed = new URL(url);
		assert.equal(parsed.origin, "https://cloudflare-dns.com", "tests must never contact a real service");
		const name = parsed.searchParams.get("name");
		asked.push(name);
		const data = answers[`${name}|${parsed.searchParams.get("type")}`];
		return Response.json(
			data === undefined
				? { Status: 3 }
				: { Status: 0, Answer: data.map((value) => ({ name, type: 0, TTL: 60, data: value })) },
		);
	});
	return asked;
}

test("a manual zone's MX is read from public DNS and compared with the provider's value", async (t) => {
	answerDns(t, { "example.com|MX": ["10 inbound-smtp.ap-northeast-1.amazonaws.com."] });
	assert.equal(await m.hasMx({}, manualDomain, "inbound-smtp.ap-northeast-1.amazonaws.com"), true);
	assert.equal(await m.hasMx({}, manualDomain, "INBOUND-SMTP.ap-northeast-1.amazonaws.com."), true);
	assert.equal(await m.hasMx({}, manualDomain, "mail.example.net"), false);
});

test("a manual zone without an MX answers false, and a failed lookup stays unknown", async (t) => {
	answerDns(t, {});
	assert.equal(await m.hasMx({}, manualDomain, "mail.example.net"), false);
	t.mock.method(globalThis, "fetch", async () => {
		throw new Error("offline");
	});
	assert.equal(await m.hasMx({}, manualDomain, "mail.example.net"), null);
	assert.equal(m.MX_UNCHECKED, "Could not check DNS from here");
});

test("a CNAME answer cannot satisfy a manual zone's MX check", async (t) => {
	answerDns(t, { "example.com|MX": ["mail.example.net."] });
	assert.equal(await m.hasMx({}, manualDomain, "mail.example.net"), false);
});

test("a CNAME followed by an MX answer matches only the MX host", async (t) => {
	answerDns(t, { "example.com|MX": ["alias.example.net.", "20 mail.example.net."] });
	assert.equal(await m.hasMx({}, manualDomain, "alias.example.net"), false);
	assert.equal(await m.hasMx({}, manualDomain, "mail.example.net"), true);
});

test("DKIM for a Resend domain is checked at Resend's selector when nothing else names one", async (t) => {
	const asked = answerDns(t, { "resend._domainkey.example.com|TXT": ['"p=abc"'] });
	const view = { routing: { records: [], missing: [] }, sending: [] };
	const resend = await m.auditDomainDns("example.com", view, "resend");
	assert.equal(resend.dkim.status, "ok");
	assert.equal(resend.dkim.name, "resend._domainkey.example.com");
	assert.ok(asked.includes("resend._domainkey.example.com"));

	const other = await m.auditDomainDns("example.com", view, "none");
	assert.equal(other.dkim.status, "unknown");
	assert.equal((await m.auditDomainDns("example.com", view)).dkim.status, "unknown");
});

test("a selector Cloudflare reports still wins over Resend's for DKIM", async (t) => {
	answerDns(t, { "cf2024-1._domainkey.example.com|TXT": ['"v=DKIM1; p=abc"'] });
	const view = { routing: { records: [], missing: [] }, sending: [], dkimSelector: "cf2024-1" };
	const audit = await m.auditDomainDns("example.com", view, "resend");
	assert.equal(audit.dkim.name, "cf2024-1._domainkey.example.com");
	assert.equal(audit.dkim.status, "ok");
});

test("hasMxMatching accepts any MX whose target matches the shape, not one exact host", async (t) => {
	answerDns(t, { "example.com|MX": ["10 inbound-smtp.eu-west-1.amazonaws.com."] });
	assert.equal(await m.hasMxMatching({}, manualDomain, m.isInboundSmtpMx), true);
	assert.equal(await m.hasMxMatching({}, manualDomain, (target) => target.endsWith(".mx.cloudflare.net")), false);
	answerDns(t, {});
	assert.equal(await m.hasMxMatching({}, manualDomain, m.isInboundSmtpMx), false);
});

test("SPF for a Resend sender is found on Resend's return-path subdomains, not just the apex", async (t) => {
	const view = { routing: { records: [], missing: [] }, sending: [] };
	answerDns(t, { "send.example.com|TXT": ['"v=spf1 include:amazonses.com ~all"'] });
	assert.equal((await m.auditDomainDns("example.com", view, "resend")).spf.status, "ok");

	answerDns(t, { "rsend.example.com|TXT": ['"v=spf1 ip4:1.2.3.4 ~all"'] });
	assert.equal((await m.auditDomainDns("example.com", view, "resend")).spf.status, "ok");

	answerDns(t, { "example.com|TXT": ['"v=spf1 include:_spf.resend.com ~all"'] });
	assert.equal((await m.auditDomainDns("example.com", view, "resend")).spf.status, "ok");

	answerDns(t, {});
	assert.equal((await m.auditDomainDns("example.com", view, "resend")).spf.status, "missing");

	// Other senders still only look at the apex.
	answerDns(t, { "send.example.com|TXT": ['"v=spf1 include:amazonses.com ~all"'] });
	assert.equal((await m.auditDomainDns("example.com", view, "cloudflare")).spf.status, "missing");
	assert.equal((await m.auditDomainDns("example.com", view)).spf.status, "missing");
});

/** Stubs the Resend account state `getResendReceivingView` reads, then returns its "mx" step. */
async function resendMxStep(t, { records = [], domainStatus = "pending", dnsAnswers = {} } = {}) {
	globalThis.__kiteResendKey = { configured: true, apiKey: "re_test", source: "settings" };
	globalThis.__kiteResendDomain = {
		id: "rd1",
		name: "example.com",
		status: domainStatus,
		capabilities: { sending: "enabled", receiving: "enabled" },
		records,
	};
	globalThis.__kiteResendWebhooks = [{ id: "w1", endpoint: "https://app.example.com/api/inbound/resend" }];
	globalThis.__kiteResendSettingsRows = [{ resendWebhookSecret: "whsec_test" }];
	answerDns(t, dnsAnswers);
	const view = await m.getResendReceivingView({}, manualDomain, "https://app.example.com");
	return view.steps.find((step) => step.key === "mx");
}

const resendMxRecord = (value, status = "pending") => ({ type: "MX", value, priority: 10, status });

test("the Resend receiving MX step accepts the published inbound-smtp record", async (t) => {
	const step = await resendMxStep(t, {
		records: [resendMxRecord("inbound-smtp.ap-northeast-1.amazonaws.com")],
		dnsAnswers: { "example.com|MX": ["10 inbound-smtp.ap-northeast-1.amazonaws.com."] },
	});
	assert.equal(step.ok, true);
});

test("the Resend receiving MX step accepts any inbound-smtp record when Resend lists none", async (t) => {
	const matching = await resendMxStep(t, {
		records: [],
		dnsAnswers: { "example.com|MX": ["10 inbound-smtp.ap-northeast-1.amazonaws.com."] },
	});
	assert.equal(matching.ok, true);

	const unrelated = await resendMxStep(t, { records: [], dnsAnswers: { "example.com|MX": ["10 mail.other.net."] } });
	assert.equal(unrelated.ok, false);
});

test("an MX record Resend verified needs no DNS re-check", async (t) => {
	const step = await resendMxStep(t, {
		records: [resendMxRecord("inbound-smtp.ap-northeast-1.amazonaws.com", "verified")],
		dnsAnswers: {},
	});
	assert.equal(step.ok, true);
});

test("an unrelated published MX still fails the Resend receiving MX step", async (t) => {
	const step = await resendMxStep(t, {
		records: [resendMxRecord("inbound-smtp.ap-northeast-1.amazonaws.com")],
		dnsAnswers: { "example.com|MX": ["10 mail.other.net."] },
	});
	assert.equal(step.ok, false);
});
