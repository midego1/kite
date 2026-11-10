import assert from "node:assert/strict";
import { createServer } from "node:http";
import test, { after } from "node:test";
import { bundleModules } from "./support/modules-bundle.mjs";

/**
 * The Node server's DNS-pinned fetch (`server/runtime/pinned-fetch.ts`) and the shared `outboundFetch`: a name is
 * resolved once, every address is checked under the caller's policy, and the socket goes to the checked address with
 * the original Host header, so a name that rebinds to a private address after the caller's own check gets nowhere.
 */
const m = await bundleModules("kite-pinned-fetch-", [
	["createPinnedFetch, OutboundAddressRefusedError", "server/runtime/pinned-fetch.ts"],
	["outboundFetch, isAllowedOutboundAddress", "src/lib/security/outbound-fetch.ts"],
	["assertPublicHttpUrl", "src/lib/security/outbound-url.ts"],
]);

const requests = [];
const server = createServer((request, response) => {
	requests.push({ url: request.url, host: request.headers.host });
	if (request.url === "/redirect-lan") {
		response.writeHead(302, { location: `http://10.255.255.1:${port}/landed` });
		return response.end();
	}
	if (request.url === "/redirect-private") {
		response.writeHead(302, { location: `http://127.0.0.1:${port}/landed` });
		return response.end();
	}
	response.writeHead(200, { "content-type": "text/plain" });
	response.end("hello");
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const { port } = server.address();
after(() => new Promise((resolve) => server.close(resolve)));

const refused = (error) => {
	const cause = error?.cause ?? error;
	assert.equal(cause?.code, "ERR_OUTBOUND_ADDRESS_REFUSED", String(cause?.stack ?? error));
	return true;
};

test("addresses: public always, loopback and private only when the caller's flag allows them", () => {
	assert.equal(m.isAllowedOutboundAddress("93.184.216.34", {}), true);
	assert.equal(m.isAllowedOutboundAddress("2606:2800:220:1::1", {}), true);
	for (const address of ["127.0.0.1", "::1", "10.0.0.5", "169.254.169.254", "::ffff:127.0.0.1", "[::1]", "fd00::1"])
		assert.equal(m.isAllowedOutboundAddress(address, {}), false, address);
	assert.equal(m.isAllowedOutboundAddress("127.0.0.1", { allowLoopback: true }), true);
	assert.equal(m.isAllowedOutboundAddress("::ffff:127.0.0.1", { allowLoopback: true }), true);
	assert.equal(m.isAllowedOutboundAddress("10.0.0.5", { allowLoopback: true }), false);
	assert.equal(m.isAllowedOutboundAddress("169.254.169.254", { allowLoopback: true }), false);
	assert.equal(m.isAllowedOutboundAddress("10.0.0.5", { allowPrivate: true }), true);
});

test("a name that rebinds between the caller's check and the connection is refused, and nothing is sent", async () => {
	// The caller's check sees a public address; the connection's own resolution sees loopback.
	let answers = 0;
	const rebinding = async () => (answers++ === 0 ? ["93.184.216.34"] : ["127.0.0.1"]);
	const pinned = m.createPinnedFetch({ resolve: rebinding });
	const env = { RESOLVE_HOST: rebinding, PINNED_FETCH: pinned };
	const url = `http://rebind.example:${port}/secret`;
	await m.assertPublicHttpUrl(env, url);
	const before = requests.length;
	await assert.rejects(m.outboundFetch(env)(url), refused);
	assert.equal(requests.length, before, "no request reached the private address");
});

test("every resolved address is checked, not only the first", async () => {
	const pinned = m.createPinnedFetch({ resolve: async () => ["93.184.216.34", "127.0.0.1"] });
	await assert.rejects(pinned(`http://mixed.example:${port}/`, undefined, {}), refused);
});

test("an allowed address is dialled with the original Host header", async () => {
	const pinned = m.createPinnedFetch({ resolve: async () => ["127.0.0.1"] });
	const response = await pinned(`http://named.example:${port}/hello`, undefined, { allowLoopback: true });
	assert.equal(response.status, 200);
	assert.equal(await response.text(), "hello");
	assert.deepEqual(requests.at(-1), { url: "/hello", host: `named.example:${port}` });
});

test("IP literals and redirects go through the same check", async () => {
	const pinned = m.createPinnedFetch({ resolve: async () => ["127.0.0.1"] });
	await assert.rejects(pinned(`http://127.0.0.1:${port}/`, undefined, {}), refused);
	await assert.rejects(pinned(`http://[::1]:${port}/`, undefined, {}), refused);
	// A followed redirect connects through the same connector: loopback is allowed here, a LAN address is not.
	await assert.rejects(
		pinned(`http://named.example:${port}/redirect-lan`, undefined, { allowLoopback: true }),
		refused,
	);
	// A redirect to an allowed literal is followed and connects.
	const followed = await pinned(`http://named.example:${port}/redirect-private`, undefined, { allowLoopback: true });
	assert.equal(await followed.text(), "hello");
	assert.equal(requests.at(-1).url, "/landed");
});

test("without PINNED_FETCH (Workers) outboundFetch is the platform's fetch", async () => {
	const response = await m.outboundFetch({}, {})(`http://127.0.0.1:${port}/plain`);
	assert.equal(await response.text(), "hello");
});
