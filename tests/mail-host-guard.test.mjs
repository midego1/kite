import assert from "node:assert/strict";
import test from "node:test";
import { bundleModules } from "./support/modules-bundle.mjs";

const { MAIL_SERVER_PORTS, mailHostPolicy, mailServerHostProblem, allowsPlainText, isLoopbackHost } =
	await bundleModules("kite-mail-host-guard-", [
		[
			"MAIL_SERVER_PORTS, mailHostPolicy, mailServerHostProblem, allowsPlainText, isLoopbackHost",
			"src/lib/net/host-guard-utils.ts",
		],
	]);

const strict = { allowInsecureLoopback: false, allowPrivate: false };
const loopback = { allowInsecureLoopback: true, allowPrivate: false };
const lan = { allowInsecureLoopback: false, allowPrivate: true };

test("the loopback flag is ignored in production and the private flag off the Node server", () => {
	const on = { EXTERNAL_ACCOUNTS_ALLOW_INSECURE_LOOPBACK: "1", EXTERNAL_ACCOUNTS_ALLOW_PRIVATE_HOSTS: "true" };
	assert.deepEqual(mailHostPolicy({ ...on, KITE_RUNTIME: "node" }, "development"), {
		allowInsecureLoopback: true,
		allowPrivate: true,
	});
	assert.deepEqual(mailHostPolicy({ ...on, KITE_RUNTIME: "node" }, "production"), {
		allowInsecureLoopback: false,
		allowPrivate: true,
	});
	assert.deepEqual(mailHostPolicy(on, undefined), { allowInsecureLoopback: true, allowPrivate: false });
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

test("the private flag allows LAN servers, still only on the mail ports", () => {
	assert.equal(mailServerHostProblem("192.168.1.20", 993, lan), null);
	assert.equal(mailServerHostProblem("mailserver", 143, lan), null);
	assert.match(mailServerHostProblem("192.168.1.20", 8080, lan), /not allowed/);
	assert.equal(allowsPlainText("127.0.0.1", lan), false);
});

test("isLoopbackHost knows loopback names and literals", () => {
	for (const host of ["localhost", "LOCALHOST.", "127.0.0.1", "127.10.0.3", "::1", "[::1]"])
		assert.equal(isLoopbackHost(host), true, host);
	for (const host of ["10.0.0.1", "127.0.0.256", "localhost.example.com", "imap.example.com"])
		assert.equal(isLoopbackHost(host), false, host);
});
