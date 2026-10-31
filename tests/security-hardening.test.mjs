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
		// Tunnels that carry an IPv4 address inside: 6to4, Teredo and local-use NAT64.
		"2002:7f00:1::1",
		"2002:a9fe:a9fe::",
		"2001:0:4136:e378:8000:63bf:3fff:fdd2",
		"2001::1",
		"64:ff9b:1::a9fe:a9fe",
	])
		assert.equal(outbound.isPrivateIpAddress(address), true, address);
	for (const address of [
		"8.8.8.8",
		"1.1.1.1",
		"172.32.0.1",
		"2606:4700:4700::1111",
		"::ffff:8.8.8.8",
		"2001:4860:4860::8888",
		"2001:db9::1",
	]) {
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
	const key = "test-key-0123456789abcdef0123456789"; // gitleaks:allow synthetic test key
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
	const token = "setup-token-for-unit-tests";
	assert.equal(
		setupToken.evaluateSetupToken({ configured: token, provided: `${token}x`, production: true }).status,
		401,
	);
	assert.deepEqual(setupToken.evaluateSetupToken({ configured: token, provided: ` ${token} `, production: true }), {
		ok: true,
	});
});

test("production refuses the example setup token and short ones, even when they match", () => {
	for (const configured of ["a-long-random-string", " a-long-random-string ", "abc", "x".repeat(15)]) {
		const decision = setupToken.evaluateSetupToken({ configured, provided: configured, production: true });
		assert.equal(decision.status, 503, configured);
		assert.match(decision.error, /example value or shorter than 16 characters/);
	}
	assert.equal(
		setupToken.evaluateSetupToken({ configured: "x".repeat(16), provided: "x".repeat(16), production: true }).ok,
		true,
	);
	assert.equal(
		setupToken.evaluateSetupToken({
			configured: "a-long-random-string",
			provided: "a-long-random-string",
			production: false,
		}).ok,
		true,
		"development keeps working with a .dev.vars copied from the example",
	);
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
const BACKGROUND = { background: true, unreadable: false, neutral: false };
const UNREADABLE = { background: false, unreadable: true, neutral: false };
const NEUTRAL = { background: false, unreadable: false, neutral: true };
const NOTHING = { background: false, unreadable: false, neutral: false };
const INVERT_RULE = /html\{background:#f2f2f0;filter:invert\(\.92\) hue-rotate\(180deg\)\}/;

test("mail with a background or an unreadable text colour is rendered light and inverted in dark mode", () => {
	const html = '<div style="background-color: #fff; color: #1F497D">Hi <img src="/x.png"></div>';
	for (const colours of [BACKGROUND, UNREADABLE, { ...NEUTRAL, unreadable: true }]) {
		const document = frame.buildEmailFrameDocument(html, { dark: true, colours });
		assert.match(document, /color-scheme:light/);
		assert.match(document, INVERT_RULE);
		assert.match(document, /img,video,picture[^{]*\{filter:invert\(1\) hue-rotate\(180deg\)\}/);
		assert.doesNotMatch(document, /data-kite-text/);
		// The markup is the sanitizer's output, never rewritten here.
		assert.ok(document.includes(html));
		const original = frame.buildEmailFrameDocument(html, { dark: true, colours, original: true });
		assert.doesNotMatch(original, /filter:invert/);
		assert.match(original, /color-scheme:light/);
		assert.match(original, /html\{background:#fff\}/);
		assert.equal(frame.emailFrameColorScheme({ dark: true, colours, original: true }), "light");
		// Light mode keeps the sender's colours on the normal canvas.
		const light = frame.buildEmailFrameDocument(html, { dark: false, colours });
		assert.doesNotMatch(light, /filter:invert|html\{background:#fff\}/);
	}
});
test("near-black text takes the theme colour in dark mode, with no inverted card", () => {
	const html = '<p style="color:black" data-kite-text="neutral">Hi <a href="https://example.com">link</a></p>';
	const document = frame.buildEmailFrameDocument(html, { dark: true, colours: NEUTRAL });
	assert.match(document, /color-scheme:dark/);
	assert.doesNotMatch(document, /filter:invert/);
	assert.doesNotMatch(document, /html\{background:#fff\}/);
	assert.ok(document.includes(html), "the sender's markup reaches the frame untouched");
	// The theme's text, quote and link colours, not inherit.
	assert.match(document, /\[data-kite-text=neutral\]\{color:#e8eaed!important\}/);
	assert.match(document, /blockquote \[data-kite-text=neutral\]\{color:#9aa0a6!important\}/);
	assert.match(document, /a\[data-kite-text=neutral\],a \[data-kite-text=neutral\]\{color:#8ab4f8!important\}/);
	assert.match(
		frame.buildEmailFrameDocument(html, { dark: true, colours: NEUTRAL, muted: true }),
		/\[data-kite-text=neutral\]\{color:#9aa0a6!important\}/,
	);
	assert.equal(frame.emailColoursAdapted(NEUTRAL), true);
	// Original colours: the sender's markup on a light canvas, without the theme rule.
	const original = frame.buildEmailFrameDocument(html, { dark: true, colours: NEUTRAL, original: true });
	assert.match(original, /color-scheme:light/);
	assert.match(original, /html\{background:#fff\}/);
	assert.doesNotMatch(original, /filter:invert|!important/);
	// Light mode never touches the colours.
	assert.doesNotMatch(
		frame.buildEmailFrameDocument(html, { dark: false, colours: NEUTRAL }),
		/data-kite-text=neutral\]\{/,
	);
});
test("mail without colour findings, or with readable ones, is left alone and offers nothing to restore", () => {
	const html = '<p style="color:#e8eaed">Hi</p><pre>&lt;td style="color:#000" bgcolor="#fff"&gt;</pre>';
	for (const colours of [undefined, NOTHING]) {
		assert.equal(frame.emailColoursAdapted(colours), false);
		const document = frame.buildEmailFrameDocument(html, { dark: true, colours });
		assert.match(document, /color-scheme:dark/);
		assert.doesNotMatch(document, /filter:invert|data-kite-text/);
		assert.ok(document.includes(html), "text that looks like markup is never rewritten");
		assert.equal(frame.emailFrameColorScheme({ dark: true, colours, original: true }), "dark");
	}
});
test("the iframe element declares the same color-scheme as the frame document", () => {
	for (const options of [
		{ dark: true, colours: NOTHING },
		{},
		{ dark: true, colours: BACKGROUND },
		{ dark: true, colours: BACKGROUND, original: true },
		{ dark: true, colours: NEUTRAL },
		{ dark: true, colours: NEUTRAL, original: true },
		{ dark: true, colours: UNREADABLE },
	]) {
		const scheme = frame.emailFrameColorScheme(options);
		assert.match(frame.buildEmailFrameDocument("<p>x</p>", options), new RegExp(`html\\{color-scheme:${scheme}\\}`));
	}
	assert.equal(frame.emailFrameColorScheme({ dark: true }), "dark");
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

test("CSP connect-src adds exact store origins and drops anything else", () => {
	const connect = (sources) =>
		headers
			.buildContentSecurityPolicy({ nonce: "n", connectSources: sources })
			.split("; ")
			.find((d) => d.startsWith("connect-src"));
	assert.equal(connect([]), "connect-src 'self' ws: wss: https://challenges.cloudflare.com");
	assert.equal(
		connect([
			"https://kite.s3.eu-central-1.amazonaws.com",
			"http://localhost:9100",
			"https://kite.s3.eu-central-1.amazonaws.com",
		]),
		"connect-src 'self' ws: wss: https://challenges.cloudflare.com https://kite.s3.eu-central-1.amazonaws.com http://localhost:9100",
	);
	for (const bad of [
		"https://*.amazonaws.com",
		"https://store.example/path",
		"https://a.example; script-src *",
		"ftp://a.example",
		"*",
	])
		assert.equal(connect([bad]), "connect-src 'self' ws: wss: https://challenges.cloudflare.com", bad);
});
