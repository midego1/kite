import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = makeBundleDirectory("kite-security-");
after(() => rmSync(outDir, { recursive: true, force: true }));

async function bundle(entry, outfile) {
	await build({
		entryPoints: [join(root, entry)],
		outfile: join(outDir, outfile),
		bundle: true,
		sourcemap: "inline",
		platform: "node",
		format: "esm",
		target: "node22",
		logLevel: "silent",
		alias: { "@": join(root, "src") },
		external: ["react", "react-dom", "next", "next/*"],
	});
	return import(pathToFileURL(join(outDir, outfile)).href);
}

const outbound = await bundle("src/lib/security/outbound-url.ts", "outbound.mjs");
const csrf = await bundle("src/lib/security/csrf.ts", "csrf.mjs");
const clientIp = await bundle("src/lib/security/client-ip.ts", "client-ip.mjs");
const secretBox = await bundle("src/lib/security/secret-box.ts", "secret-box.mjs");
const setupToken = await bundle("src/lib/auth/setup-token-utils.ts", "setup-token.mjs");
const headers = await bundle("src/lib/security/headers.ts", "headers.mjs");
const frame = await bundle("src/components/messages/email-html-frame-utils.ts", "frame.mjs");

test("private, loopback, link-local and metadata addresses are blocked", () => {
	for (const address of [
		"127.0.0.1",
		"10.1.2.3",
		"172.16.0.1",
		"172.31.255.255",
		"192.168.1.1",
		"169.254.169.254",
		"100.64.0.1",
		"0.0.0.0",
		"224.0.0.1",
		"255.255.255.255",
		"::1",
		"::",
		"fe80::1",
		"fd00::1",
		"::ffff:127.0.0.1",
		"::ffff:7f00:1",
		"[::1]",
		"64:ff9b::a9fe:a9fe",
	])
		assert.equal(outbound.isPrivateIpAddress(address), true, address);
	for (const address of ["8.8.8.8", "1.1.1.1", "172.32.0.1", "2606:4700:4700::1111", "::ffff:8.8.8.8"]) {
		assert.equal(outbound.isPrivateIpAddress(address), false, address);
	}
});

test("blocked hosts include local names and IP literals", () => {
	for (const host of [
		"localhost",
		"api.localhost",
		"printer.local",
		"metadata.google.internal",
		"intranet",
		"127.0.0.1",
		"[::1]",
		"",
	]) {
		assert.equal(outbound.isBlockedHost(host), true, host);
	}
	assert.equal(outbound.isBlockedHost("hooks.example.com"), false);
	assert.equal(outbound.isBlockedHost("93.184.216.34"), false);
});

test("webhook URLs must be public http(s)", () => {
	assert.equal(outbound.isPublicHttpUrl("https://hooks.example.com/x"), true);
	assert.equal(outbound.isPublicHttpUrl("http://127.0.0.1:8080/"), false);
	assert.equal(outbound.isPublicHttpUrl("http://2130706433/"), false, "numeric IPv4 is normalised by URL");
	assert.equal(outbound.isPublicHttpUrl("http://[::ffff:127.0.0.1]/"), false);
	assert.equal(outbound.isPublicHttpUrl("file:///etc/passwd"), false);
	assert.equal(outbound.isPublicHttpUrl("https://user:pass@example.com/"), false);
});

test("resolved addresses are checked when the runtime can resolve names", async () => {
	const privateEnv = { RESOLVE_HOST: async () => ["10.0.0.5"] };
	await assert.rejects(outbound.assertPublicHttpUrl(privateEnv, "https://rebind.example.com/"), /Private/);
	const publicEnv = { RESOLVE_HOST: async () => ["93.184.216.34"] };
	assert.equal((await outbound.assertPublicHttpUrl(publicEnv, "https://example.com/hook")).hostname, "example.com");
	assert.equal((await outbound.assertPublicHttpUrl({}, "https://example.com/hook")).hostname, "example.com");
});

test("CSRF checks only cover unsafe /api requests outside the exempt prefixes", () => {
	assert.equal(csrf.requiresCsrfCheck("POST", "/api/messages/bulk"), true);
	assert.equal(csrf.requiresCsrfCheck("delete", "/api/domains/1"), true);
	assert.equal(csrf.requiresCsrfCheck("GET", "/api/messages"), false);
	assert.equal(csrf.requiresCsrfCheck("POST", "/api/v1/send"), false);
	assert.equal(csrf.requiresCsrfCheck("POST", "/api/inbound"), false);
	assert.equal(csrf.requiresCsrfCheck("POST", "/api/inbound/ses"), false);
	assert.equal(csrf.requiresCsrfCheck("POST", "/api/inboundx"), true);
	assert.equal(csrf.requiresCsrfCheck("POST", "/api/public/booking"), false);
	assert.equal(csrf.requiresCsrfCheck("POST", "/mcp"), false);
	assert.equal(csrf.requiresCsrfCheck("POST", "/jmap/api"), false);
});

test("mutation origin decision", () => {
	const base = { authorization: null, fetchSite: null, origin: null, allowedHosts: ["mail.example.com"] };
	assert.equal(csrf.isAllowedMutationRequest({ ...base, fetchSite: "same-origin" }), true);
	assert.equal(
		csrf.isAllowedMutationRequest({ ...base, fetchSite: "cross-site", origin: "https://mail.example.com" }),
		false,
	);
	assert.equal(csrf.isAllowedMutationRequest({ ...base, fetchSite: "same-site" }), false);
	assert.equal(csrf.isAllowedMutationRequest({ ...base, origin: "https://mail.example.com" }), true);
	assert.equal(csrf.isAllowedMutationRequest({ ...base, origin: "https://evil.example" }), false);
	assert.equal(csrf.isAllowedMutationRequest({ ...base, origin: "null" }), false);
	assert.equal(csrf.isAllowedMutationRequest(base), false);
	assert.equal(csrf.isAllowedMutationRequest({ ...base, authorization: "Bearer key", fetchSite: "cross-site" }), true);
	assert.deepEqual(csrf.getAllowedMutationHosts("localhost:3000", "https://mail.example.com/"), [
		"localhost:3000",
		"mail.example.com",
	]);
});

test("checkCsrf blocks a cross-site cookie POST and passes a same-origin one", () => {
	const cross = new Request("https://mail.example.com/api/settings/password", {
		method: "POST",
		headers: { Origin: "https://evil.example", Cookie: "ep_session=x" },
	});
	assert.equal(csrf.checkCsrf(cross)?.status, 403);
	const same = new Request("https://mail.example.com/api/settings/password", {
		method: "POST",
		headers: { "Sec-Fetch-Site": "same-origin" },
	});
	assert.equal(csrf.checkCsrf(same), null);
	const webhook = new Request("https://mail.example.com/api/inbound/resend", { method: "POST" });
	assert.equal(csrf.checkCsrf(webhook), null);
});

test("client IP headers are ignored unless the proxy is trusted", () => {
	const input = { socketAddress: "::ffff:203.0.113.9", cfConnectingIp: "1.2.3.4", forwardedFor: "5.6.7.8, 9.9.9.9" };
	assert.equal(clientIp.resolveClientIp({ ...input, trustProxy: false }), "203.0.113.9");
	assert.equal(clientIp.resolveClientIp({ ...input, trustProxy: true }), "1.2.3.4");
	assert.equal(clientIp.resolveClientIp({ ...input, cfConnectingIp: null, trustProxy: true }), "9.9.9.9");
	assert.equal(clientIp.isTrustProxyEnabled("true"), true);
	assert.equal(clientIp.isTrustProxyEnabled(undefined), false);
	assert.equal(clientIp.isTrustProxyEnabled("0"), false);
});

test("secret box round-trips and reads legacy plaintext", async () => {
	const key = "test-key-0123456789abcdef0123456789";
	const sealed = await secretBox.sealSecret(key, "re_secret");
	assert.match(sealed, /^enc:v1:/);
	assert.notEqual(sealed, await secretBox.sealSecret(key, "re_secret"), "fresh IV every time");
	assert.equal(await secretBox.openSecret(key, sealed), "re_secret");
	assert.equal(await secretBox.openSecret(key, "legacy plaintext"), "legacy plaintext");
	assert.equal(await secretBox.sealSecret(undefined, "plain"), "plain");
	assert.equal(await secretBox.sealSecret(key, sealed), sealed, "never double-encrypts");
	await assert.rejects(secretBox.openSecret("other-key", sealed), /could not be decrypted/);
	await assert.rejects(secretBox.openSecret(undefined, sealed), /APP_ENCRYPTION_KEY is not set/);
	assert.equal(await secretBox.openSetting({ APP_ENCRYPTION_KEY: key }, null), null);
});

test("setup token decision", () => {
	assert.deepEqual(setupToken.evaluateSetupToken({ configured: undefined, provided: null, production: false }), {
		ok: true,
	});
	assert.equal(setupToken.evaluateSetupToken({ configured: undefined, provided: null, production: true }).status, 503);
	assert.equal(setupToken.evaluateSetupToken({ configured: "abc", provided: null, production: false }).status, 401);
	assert.equal(setupToken.evaluateSetupToken({ configured: "abc", provided: "abd", production: true }).status, 401);
	assert.deepEqual(setupToken.evaluateSetupToken({ configured: "abc", provided: " abc ", production: true }), {
		ok: true,
	});
});

test("email frame sandbox never allows scripts", () => {
	assert.doesNotMatch(frame.EMAIL_FRAME_SANDBOX, /allow-scripts/);
	assert.match(frame.EMAIL_FRAME_SANDBOX, /allow-popups-to-escape-sandbox/);
	const document = frame.buildEmailFrameDocument("<p>Hi</p>", { dark: true });
	assert.match(document, /<base target="_blank">/);
	assert.match(document, /color-scheme:dark/);
	assert.match(document, /<p>Hi<\/p>/);
	assert.match(frame.buildEmailFrameDocument("x"), /color-scheme:light/);
});
test("designed mail is rendered light and inverted in dark mode, with media inverted back", () => {
	for (const html of [
		'<table bgcolor="#ffffff"><tr><td>Hi</td></tr></table>',
		'<div style="background-color: #fff">Hi</div>',
		"<style>.card{background:#f5f5f5}</style><div class=card>Hi</div>",
	]) {
		const document = frame.buildEmailFrameDocument(html, { dark: true });
		assert.match(document, /color-scheme:light/, html);
		assert.match(document, /html\{background:#f2f2f0;filter:invert\(\.92\) hue-rotate\(180deg\)\}/, html);
		assert.match(document, /img,video,picture[^{]*\{filter:invert\(1\) hue-rotate\(180deg\)\}/, html);
		const original = frame.buildEmailFrameDocument(html, { dark: true, original: true });
		assert.doesNotMatch(original, /filter:invert/, html);
		assert.match(original, /html\{background:#fff\}/, html);
	}
	for (const html of ["<p>Plain reply</p>", '<div style="background: transparent">Hi</div>']) {
		const document = frame.buildEmailFrameDocument(html, { dark: true });
		assert.match(document, /color-scheme:dark/, html);
		assert.doesNotMatch(document, /html\{background:#fff\}/, html);
	}
	assert.doesNotMatch(frame.buildEmailFrameDocument('<td bgcolor="#fff">x</td>'), /html\{background:#fff\}/);
});
test("the iframe element declares the same color-scheme as the frame document", () => {
	for (const [html, options] of [
		["<p>Plain reply</p>", { dark: true }],
		["<p>Plain reply</p>", {}],
		['<div style="background-color: #fff">Hi</div>', { dark: true }],
		['<div style="background-color: #fff">Hi</div>', { dark: true, original: true }],
	]) {
		const scheme = frame.emailFrameColorScheme(html, options);
		assert.match(frame.buildEmailFrameDocument(html, options), new RegExp(`html\\{color-scheme:${scheme}\\}`));
	}
	assert.equal(frame.emailFrameColorScheme("<p>Plain reply</p>", { dark: true }), "dark");
});

test("production CSP allows inline scripts only by nonce", () => {
	const production = headers.buildContentSecurityPolicy({ nonce: "abc123" });
	assert.match(production, /script-src 'self' https:\/\/challenges\.cloudflare\.com 'nonce-abc123'/);
	assert.doesNotMatch(production, /unsafe-inline'[^;]*;\s*style/);
	assert.doesNotMatch(
		production.split("; ").find((d) => d.startsWith("script-src")),
		/unsafe/,
	);
	assert.match(production, /object-src 'none'/);
	assert.match(production, /base-uri 'self'/);
	assert.match(production, /frame-ancestors 'self'/);
	assert.match(headers.buildContentSecurityPolicy({ dev: true }), /'unsafe-eval'/);
	assert.notEqual(headers.createCspNonce(), headers.createCspNonce());
	assert.equal(headers.isDocumentPath("/inbox"), true);
	assert.equal(headers.isDocumentPath("/api/messages"), false);
	assert.equal(headers.isDocumentPath("/_next/static/a.js"), false);
});
