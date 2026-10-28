import assert from "node:assert/strict";
import test from "node:test";
import { bundleModules } from "./support/modules-bundle.mjs";

const {
	MAIL_SERVER_PORTS,
	mailHostPolicy,
	mailServerHostProblem,
	allowsPlainText,
	isLoopbackHost,
	isLanAddress,
	canonicalMailHost,
	parsePortList,
} = await bundleModules("kite-mail-host-guard-", [
	[
		"MAIL_SERVER_PORTS, mailHostPolicy, mailServerHostProblem, allowsPlainText, isLoopbackHost, isLanAddress, canonicalMailHost, parsePortList",
		"src/lib/net/host-guard-utils.ts",
	],
]);

const strict = { allowInsecureLoopback: false, allowPrivate: false, extraPorts: [] };
const loopback = { allowInsecureLoopback: true, allowPrivate: false, extraPorts: [] };
const lan = { allowInsecureLoopback: false, allowPrivate: true, extraPorts: [] };

test("the loopback flag is ignored in production and the private flag off the Node server", () => {
	const on = {
		EXTERNAL_ACCOUNTS_ALLOW_INSECURE_LOOPBACK: "1",
		EXTERNAL_ACCOUNTS_ALLOW_PRIVATE_HOSTS: "true",
		EXTERNAL_ACCOUNTS_EXTRA_PORTS: "1143",
	};
	assert.deepEqual(mailHostPolicy({ ...on, KITE_RUNTIME: "node" }, "development"), {
		allowInsecureLoopback: true,
		allowPrivate: true,
		extraPorts: [1143],
	});
	assert.deepEqual(mailHostPolicy({ ...on, KITE_RUNTIME: "node" }, "production"), {
		allowInsecureLoopback: false,
		allowPrivate: true,
		extraPorts: [1143],
	});
	// Workers keep the strict ports and refuse private hosts whatever the variables say.
	assert.deepEqual(mailHostPolicy(on, undefined), { allowInsecureLoopback: true, allowPrivate: false, extraPorts: [] });
	assert.deepEqual(mailHostPolicy({ EXTERNAL_ACCOUNTS_ALLOW_INSECURE_LOOPBACK: "yes" }, undefined), strict);
	assert.deepEqual(mailHostPolicy({}, undefined), strict);
});

test("public hosts on the mail ports pass; other ports and local hosts do not", () => {
	assert.deepEqual([...MAIL_SERVER_PORTS], [993, 143, 465, 587]);
	for (const port of MAIL_SERVER_PORTS) assert.equal(mailServerHostProblem("imap.example.com", port, strict), null);
	assert.match(mailServerHostProblem("imap.example.com", 25, strict), /Port 25 is not allowed.*993, 143, 465 or 587/);
	assert.match(mailServerHostProblem("imap.example.com", 465, strict, [993, 143]), /993 or 143/);
	assert.match(mailServerHostProblem("imap.example.com", 443, strict, [993]), /on port 993$/);
	for (const host of [
		"127.0.0.1",
		"localhost",
		"[::1]",
		"10.0.0.5",
		"192.168.1.9",
		"169.254.169.254",
		"mail.internal",
		"intranet",
		"printer.local",
	])
		assert.match(mailServerHostProblem(host, 993, strict), /Private and local/, host);
	assert.match(mailServerHostProblem("  ", 993, strict), /Enter the mail server name/);
	for (const port of [0, 70000, 1.5, Number.NaN])
		assert.match(mailServerHostProblem("imap.example.com", port, strict), /invalid/);
});

test("the dev flag allows loopback on any port, and nothing else", () => {
	assert.equal(mailServerHostProblem("127.0.0.1", 31993, loopback), null);
	assert.equal(mailServerHostProblem("localhost", 1143, loopback), null);
	assert.match(mailServerHostProblem("10.0.0.5", 993, loopback), /Private and local/);
	assert.match(mailServerHostProblem("imap.example.com", 1143, loopback), /not allowed/);
	assert.equal(allowsPlainText("127.0.0.1", loopback), true);
	assert.equal(allowsPlainText("127.0.0.1", strict), false);
	assert.equal(allowsPlainText("imap.example.com", loopback), false);
});

test("the private flag allows LAN servers only, still on the mail ports", () => {
	for (const host of [
		"192.168.1.20",
		"10.0.0.5",
		"172.16.4.4",
		"172.31.0.1",
		"fd12:3456::1",
		"[fc00::5]",
		"mailserver",
	])
		assert.equal(mailServerHostProblem(host, 993, lan), null, host);
	assert.match(mailServerHostProblem("192.168.1.20", 8080, lan), /not allowed/);
	// Loopback, link-local (the metadata address), 0.0.0.0/8, CGNAT and mapped forms stay refused.
	for (const host of [
		"127.0.0.1",
		"0177.0.0.1",
		"localhost",
		"imap.localhost",
		"::1",
		"169.254.169.254",
		"169.254.1.1",
		"fe80::1",
		"0.0.0.0",
		"0.1.2.3",
		"100.64.0.1",
		"::ffff:10.0.0.5",
	])
		assert.match(mailServerHostProblem(host, 993, lan), /Private and local/, host);
	assert.equal(allowsPlainText("127.0.0.1", lan), false);
});

test("isLanAddress opens RFC 1918 and unique local addresses only", () => {
	for (const address of ["10.1.2.3", "172.16.0.1", "172.31.255.254", "192.168.0.1", "fd00::1", "fc00::1", "012.0.0.1"])
		assert.equal(isLanAddress(address), true, address);
	for (const address of [
		"172.15.0.1",
		"172.32.0.1",
		"127.0.0.1",
		"169.254.169.254",
		"0.0.0.0",
		"100.64.0.1",
		"fe80::1",
		"::1",
		"8.8.8.8",
		"mail.example.com",
		"f::1",
	])
		assert.equal(isLanAddress(address), false, address);
});

test("IPv4 shorthands are checked as the address they spell", () => {
	assert.equal(canonicalMailHost("0177.0.0.1"), "127.0.0.1");
	assert.equal(canonicalMailHost("127.1"), "127.0.0.1");
	assert.equal(canonicalMailHost("0x7f.0.0.1"), "127.0.0.1");
	assert.equal(canonicalMailHost("2130706433"), "127.0.0.1");
	assert.equal(canonicalMailHost(" Imap.Example.COM. "), "imap.example.com");
	assert.equal(canonicalMailHost("bücher.example"), "xn--bcher-kva.example");
	for (const host of [
		"a b",
		"user@host.example",
		"host.example:99",
		"host.example/x",
		"host.example?x",
		"::zz",
		"",
		"127.0.0.1...",
		"127.0.0.1..",
		".imap.example.com",
		"imap..example.com",
		"imap.example.com..",
	])
		assert.equal(canonicalMailHost(host), null, host);
	for (const host of ["0177.0.0.1", "127.1", "0x7f.0.0.1", "2130706433", "0x0a.1", "0251.0376.0251.0376", "0xa9fea9fe"])
		assert.match(mailServerHostProblem(host, 993, strict), /Private and local/, host);
	assert.match(mailServerHostProblem("user@imap.example.com", 993, strict), /invalid/);
	assert.match(mailServerHostProblem("127.0.0.1...", 993, loopback), /invalid/);
	assert.equal(canonicalMailHost("imap.example.com."), "imap.example.com");
	for (const host of ["127.1", "0x7f.0.0.1"]) assert.equal(isLoopbackHost(host), true, host);
});

test("extra ports are added to the mail ports, never replace them", () => {
	assert.deepEqual(parsePortList(" 1143, 1025,abc, 0, 70000, 1143, 12.5"), [1143, 1025]);
	assert.deepEqual(parsePortList(undefined), []);
	const bridge = { ...lan, extraPorts: [1143] };
	assert.equal(mailServerHostProblem("172.18.0.4", 1143, bridge), null);
	assert.equal(mailServerHostProblem("imap.example.com", 993, bridge), null);
	assert.match(mailServerHostProblem("imap.example.com", 1025, bridge), /993, 143, 465, 587 or 1143$/);
	assert.match(mailServerHostProblem("127.0.0.1", 1143, bridge), /Private and local/);
});

test("isLoopbackHost knows loopback names and literals", () => {
	for (const host of ["localhost", "LOCALHOST.", "127.0.0.1", "127.10.0.3", "::1", "[::1]", "imap.localhost"])
		assert.equal(isLoopbackHost(host), true, host);
	for (const host of ["10.0.0.1", "127.0.0.256", "localhost.example.com", "imap.example.com", "a b"])
		assert.equal(isLoopbackHost(host), false, host);
});
