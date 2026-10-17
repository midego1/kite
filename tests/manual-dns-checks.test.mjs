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
await build({
	stdin: {
		contents: `
			export { hasMx, MX_UNCHECKED } from "./src/lib/domains/receiving-dns.ts";
			export { auditDomainDns } from "./src/lib/domains/dns-audit.ts";
			export { MANUAL_ZONE_ID } from "./src/lib/domains/provision.ts";
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
