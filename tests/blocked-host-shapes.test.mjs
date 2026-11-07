import assert from "node:assert/strict";
import test from "node:test";
import { bundleModules } from "./support/modules-bundle.mjs";

const {
	canonicalHost,
	isBlockedHost,
	parsePublicHttpUrl,
	assertPublicHttpUrl,
	validateAlertWebhookUrl,
	parseRemoteImageUrl,
	endpointProblem,
	isLoopbackHostname,
	mailServerHostProblem,
} = await bundleModules("kite-blocked-host-shapes-", [
	["canonicalHost, isBlockedHost, parsePublicHttpUrl, assertPublicHttpUrl", "src/lib/security/outbound-url.ts"],
	["validateAlertWebhookUrl", "src/lib/alerts/webhook-utils.ts"],
	["parseRemoteImageUrl", "src/lib/remote-images/fetch-utils.ts"],
	["endpointProblem, isLoopbackHostname", "src/lib/storage/endpoint-utils.ts"],
	["mailServerHostProblem", "src/lib/net/host-guard-utils.ts"],
]);

/** Every way of writing a private, loopback or metadata address that a literal check must still see through. */
const BYPASS_SHAPES = {
	"IPv4-mapped and translated IPv6": [
		"[::ffff:127.0.0.1]",
		"[::ffff:7f00:1]",
		"[0:0:0:0:0:ffff:127.0.0.1]",
		"[::ffff:10.0.0.1]",
		"[::ffff:a9fe:a9fe]",
		"[::127.0.0.1]",
		"[64:ff9b::a9fe:a9fe]",
		"[2002:7f00:1::]",
	],
	"decimal, octal and hex IPv4": [
		"2130706433",
		"167772161",
		"2852039166",
		"0177.0.0.1",
		"017700000001",
		"0251.0376.0251.0376",
		"0x7f.0.0.1",
		"0x7f000001",
		"0xa9fea9fe",
		"0x0a.1",
	],
	"IPv4 shorthands": ["127.1", "127.0.1", "10.1", "192.168.1"],
	"trailing dots": [
		"localhost.",
		"127.0.0.1.",
		"metadata.google.internal.",
		"printer.local.",
		"localhost..",
		"127.0.0.1..",
		"intranet.",
	],
	"IDN and Unicode spellings": [
		"ｌｏｃａｌｈｏｓｔ",
		"ⓛⓞⓒⓐⓛⓗⓞⓢⓣ",
		"LOCALHOST",
		"Metadata.Google.Internal",
		"１２７.０.０.１",
		"127。0。0。1",
		"printer．local",
		"localhost。",
	],
	"percent-encoded": ["%31%32%37.0.0.1", "127.0.0.1%2e"],
	"not a host at all": ["", " ", "a..b", ".example.com", "1.2.3.4.5", "exa mple.com"],
};

/** Public hosts every guard must keep letting through, so the canonical form costs no legitimate destination. */
const PUBLIC_HOSTS = [
	"hooks.example.com",
	"Hooks.Example.COM.",
	"bücher.example.com",
	"xn--bcher-kva.example.com",
	"93.184.216.34",
	"[2606:4700:4700::1111]",
	"ec2-54-12-34-56.compute-1.amazonaws.com",
];

const shapes = Object.entries(BYPASS_SHAPES).flatMap(([shape, hosts]) => hosts.map((host) => ({ shape, host })));
// In a URL an empty host is not one: `https:///a.png` parses with the host `a.png`.
const urlShapes = shapes.filter(({ host }) => host.trim());
const label = ({ shape, host }) => `${shape}: ${JSON.stringify(host)}`;
const strictMail = { allowInsecureLoopback: false, allowPrivate: false, extraPorts: [] };
const strictStore = { allowInsecure: false, allowPrivate: false };

test("canonicalHost spells every address one way", () => {
	assert.equal(canonicalHost("127.1"), "127.0.0.1");
	assert.equal(canonicalHost("0x7f.0.0.1"), "127.0.0.1");
	assert.equal(canonicalHost("2130706433"), "127.0.0.1");
	assert.equal(canonicalHost("１２７.０.０.１"), "127.0.0.1");
	assert.equal(canonicalHost("127。0。0。1"), "127.0.0.1");
	assert.equal(canonicalHost("%31%32%37.0.0.1"), "127.0.0.1");
	assert.equal(canonicalHost("ｌｏｃａｌｈｏｓｔ"), "localhost");
	assert.equal(canonicalHost("localhost。"), "localhost");
	assert.equal(canonicalHost("[::FFFF:127.0.0.1]"), "::ffff:127.0.0.1");
	assert.equal(canonicalHost(" Hooks.Example.COM. "), "hooks.example.com");
	assert.equal(canonicalHost("bücher.example"), "xn--bcher-kva.example");
	for (const host of ["", "localhost..", "a..b", "1.2.3.4.5", "user@host.example", "host.example:99", "::zz"])
		assert.equal(canonicalHost(host), null, host);
});

test("isBlockedHost blocks every bypass shape", () => {
	for (const entry of shapes) assert.equal(isBlockedHost(entry.host), true, label(entry));
	for (const host of PUBLIC_HOSTS) assert.equal(isBlockedHost(host), false, host);
});

test("webhook URLs refuse every bypass shape", () => {
	for (const entry of urlShapes) {
		const url = `https://${entry.host}/hook`;
		assert.throws(() => parsePublicHttpUrl(url), undefined, label(entry));
		assert.equal(validateAlertWebhookUrl(url, { allowInsecureLoopback: false }).ok, false, label(entry));
	}
	for (const host of PUBLIC_HOSTS) {
		assert.equal(parsePublicHttpUrl(`https://${host}/hook`).protocol, "https:", host);
		assert.equal(validateAlertWebhookUrl(`https://${host}/hook`, { allowInsecureLoopback: false }).ok, true, host);
	}
});

test("remote images refuse every bypass shape", () => {
	const policy = { appOrigin: "https://kite.example.org" };
	for (const entry of urlShapes)
		assert.throws(() => parseRemoteImageUrl(`https://${entry.host}/a.png`, policy), undefined, label(entry));
	assert.equal(parseRemoteImageUrl("https://bücher.example.com/a.png", policy).hostname, "xn--bcher-kva.example.com");
});

test("object store endpoints refuse every bypass shape", () => {
	for (const entry of shapes)
		assert.notEqual(endpointProblem({ endpoint: entry.host, scheme: "https" }, strictStore), null, label(entry));
	for (const host of PUBLIC_HOSTS.filter((host) => !host.startsWith("[")))
		assert.equal(endpointProblem({ endpoint: host, scheme: "https" }, strictStore), null, host);
	// The dev flag opens loopback only, however it is spelled, and still nothing private.
	const insecure = { allowInsecure: true, allowPrivate: false };
	for (const host of ["127.1", "0x7f.0.0.1", "localhost.", "ｌｏｃａｌｈｏｓｔ"]) {
		assert.equal(isLoopbackHostname(host), true, host);
		assert.equal(endpointProblem({ endpoint: `${host}:9000`, scheme: "http" }, insecure), null, host);
	}
	for (const host of ["10.1", "0xa9fea9fe", "[::ffff:10.0.0.1]"])
		assert.match(endpointProblem({ endpoint: host, scheme: "http" }, insecure), /Private/, host);
});

test("mail servers refuse every bypass shape", () => {
	for (const entry of shapes) assert.notEqual(mailServerHostProblem(entry.host, 993, strictMail), null, label(entry));
	for (const host of PUBLIC_HOSTS) assert.equal(mailServerHostProblem(host, 993, strictMail), null, host);
});

test("DNS rebinding stays covered: a public name resolving to a private address is refused", async () => {
	const resolving = (addresses) => ({ RESOLVE_HOST: async () => addresses });
	for (const address of ["127.0.0.1", "10.0.0.5", "169.254.169.254", "::1", "::ffff:127.0.0.1", "fd00::1"])
		await assert.rejects(
			assertPublicHttpUrl(resolving(["93.184.216.34", address]), "https://hooks.example.com/"),
			/Private and local/,
			address,
		);
	await assert.rejects(assertPublicHttpUrl(resolving([]), "https://hooks.example.com/"), /Could not resolve/);
	const url = await assertPublicHttpUrl(resolving(["93.184.216.34"]), "https://hooks.example.com/");
	assert.equal(url.hostname, "hooks.example.com");
});
