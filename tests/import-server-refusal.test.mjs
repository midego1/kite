import assert from "node:assert/strict";
import test from "node:test";
import { bundleModules } from "./support/modules-bundle.mjs";

// Saving an import job resolves the server's name on the Node server (issue #149), so a name that points at a private
// address is refused when the job is created, not only when its first run connects.

const { importServerRefusal } = await bundleModules("kite-import-server-refusal-", [
	["importServerRefusal", "src/lib/import/imap.ts"],
]);

/** A Node env whose resolver answers `addresses` (or throws) and records every name it was asked for. */
function resolving(addresses, extra = {}) {
	const asked = [];
	return {
		asked,
		env: {
			KITE_RUNTIME: "node",
			...extra,
			RESOLVE_HOST: async (host) => {
				asked.push(host);
				if (addresses instanceof Error) throw addresses;
				return addresses;
			},
		},
	};
}

test("without a resolver (Workers) only the literal check runs", async () => {
	assert.equal(await importServerRefusal({}, { host: "imap.example.org", port: 993 }), null);
	assert.equal(await importServerRefusal({}, { host: "imap.example.org", port: 143 }), null);
	assert.match(await importServerRefusal({}, { host: "imap.example.org", port: 465 }), /Port 465 is not allowed/);
	for (const host of ["10.0.0.5", "127.1", "0x7f.0.0.1", "localhost", "intranet", "[::ffff:127.0.0.1]"])
		assert.match(await importServerRefusal({}, { host, port: 993 }), /Private and local/, host);
});

test("on Node a name that resolves to any private address is refused", async () => {
	for (const address of ["10.1.2.3", "127.0.0.1", "169.254.169.254", "::1", "::ffff:192.168.1.9", "fd00::5"]) {
		const { env, asked } = resolving(["93.184.216.34", address]);
		assert.match(
			await importServerRefusal(env, { host: " imap.example.org ", port: 993 }),
			/Private and local/,
			address,
		);
		assert.deepEqual(asked, ["imap.example.org"]);
	}
	const { env, asked } = resolving(["93.184.216.34", "2606:4700::1111"]);
	assert.equal(await importServerRefusal(env, { host: "imap.example.org", port: 993 }), null);
	assert.deepEqual(asked, ["imap.example.org"]);
});

test("on Node a name that does not resolve is refused", async () => {
	assert.match(
		await importServerRefusal(resolving([]).env, { host: "imap.example.org", port: 993 }),
		/could not find the mail server imap\.example\.org/,
	);
	assert.match(
		await importServerRefusal(resolving(new Error("ENOTFOUND")).env, { host: "imap.example.org", port: 993 }),
		/could not find the mail server imap\.example\.org/,
	);
});

test("literals are not resolved, and a refused literal never reaches the resolver", async () => {
	const publicLiteral = resolving(["10.0.0.1"]);
	assert.equal(await importServerRefusal(publicLiteral.env, { host: "93.184.216.34", port: 993 }), null);
	assert.deepEqual(publicLiteral.asked, []);
	const privateLiteral = resolving(["93.184.216.34"]);
	assert.match(await importServerRefusal(privateLiteral.env, { host: "10.0.0.1", port: 993 }), /Private and local/);
	assert.deepEqual(privateLiteral.asked, []);
});

test("the private-host setting opens LAN addresses only, never loopback or link-local", async () => {
	const lan = { EXTERNAL_ACCOUNTS_ALLOW_PRIVATE_HOSTS: "1" };
	assert.equal(
		await importServerRefusal(resolving(["192.168.1.9"], lan).env, { host: "imap.lan.example", port: 993 }),
		null,
	);
	for (const address of ["127.0.0.1", "169.254.169.254", "0.0.0.1"])
		assert.match(
			await importServerRefusal(resolving([address], lan).env, { host: "imap.lan.example", port: 993 }),
			/Private and local/,
			address,
		);
});
