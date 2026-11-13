import assert from "node:assert/strict";
import { createServer } from "node:http";
import test, { after, before } from "node:test";
import { bundleModules } from "./support/modules-bundle.mjs";

// The Node server's pinned POST (`server/runtime/pinned-post.ts`, `env.PINNED_POST`) that one-click unsubscribe
// uses: the name is resolved once, every address must be public, and the connection goes only to the addresses
// that were checked, so a DNS answer that changes afterwards (rebinding) cannot reach a private host.

const { createPinnedPost, postOneClickUnsubscribe, OutboundUrlError } = await bundleModules("kite-pinned-post-", [
	["createPinnedPost", "server/runtime/pinned-post.ts"],
	["postOneClickUnsubscribe", "src/lib/email/one-click-unsubscribe-utils.ts"],
	["OutboundUrlError", "src/lib/security/outbound-url.ts"],
]);

const received = [];
let server;
let port;
before(async () => {
	server = createServer((request, response) => {
		let body = "";
		request.on("data", (chunk) => (body += chunk));
		request.on("end", () => {
			received.push({
				host: request.headers.host,
				method: request.method,
				body,
				type: request.headers["content-type"],
			});
			response.writeHead(request.url === "/fail" ? 500 : 200);
			response.end("ignored");
		});
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	port = server.address().port;
});
after(() => new Promise((resolve) => server.close(resolve)));

const signal = () => AbortSignal.timeout(5_000);
const POST = { body: "List-Unsubscribe=One-Click", headers: { "Content-Type": "application/x-www-form-urlencoded" } };

test("every address must be public: a private one anywhere in the answer, or no answer, refuses", async () => {
	const before = received.length;
	const attempt = (resolve, host = "news.example") =>
		createPinnedPost({ resolve })(`http://${host}:${port}/u`, { ...POST, signal: signal() });
	for (const addresses of [["93.184.216.34", "10.0.0.5"], ["127.0.0.1"], ["169.254.169.254"], ["::1"], ["fd00::1"], []])
		await assert.rejects(
			attempt(async () => addresses),
			OutboundUrlError,
			String(addresses),
		);
	await assert.rejects(
		attempt(async () => {
			throw new Error("ENOTFOUND");
		}),
		OutboundUrlError,
	);
	// An IP literal is checked as it is, without a lookup.
	let looked = false;
	await assert.rejects(
		attempt(async () => {
			looked = true;
			return ["93.184.216.34"];
		}, "127.0.0.1"),
		OutboundUrlError,
	);
	assert.equal(looked, false);
	assert.equal(received.length, before, "nothing connected");
});

test("the connection goes to the address that was checked, even when the name later resolves elsewhere", async () => {
	// The first answer is the one checked (loopback stands in for a public address, as only tests allow); a rebinding
	// resolver would answer a private address next time. It is never asked again: the connection uses the pin.
	let lookups = 0;
	const resolve = async () => (++lookups === 1 ? ["127.0.0.1"] : ["10.0.0.5"]);
	const post = createPinnedPost({ resolve, allowLoopback: true });
	const before = received.length;
	assert.deepEqual(await post(`http://rebind.example:${port}/u`, { ...POST, signal: signal() }), { status: 200 });
	assert.equal(lookups, 1);
	assert.deepEqual(received.slice(before), [
		{
			host: `rebind.example:${port}`,
			method: "POST",
			body: "List-Unsubscribe=One-Click",
			type: "application/x-www-form-urlencoded",
		},
	]);
	// Each request resolves afresh: the next one sees the rebound answer and is refused, never connected.
	await assert.rejects(post(`http://rebind.example:${port}/u`, { ...POST, signal: signal() }), OutboundUrlError);
	assert.equal(received.length, before + 1);
	const failing = createPinnedPost({ resolve: async () => ["127.0.0.1"], allowLoopback: true });
	assert.deepEqual(await failing(`http://fails.example:${port}/fail`, { ...POST, signal: signal() }), { status: 500 });
});

test("a private answer is refused before anything connects, and one-click reports it as a refused URL", async () => {
	const before = received.length;
	const post = createPinnedPost({ resolve: async () => ["93.184.216.34", "127.0.0.1"] });
	await assert.rejects(post(`http://mixed.example:${port}/u`, { ...POST, signal: signal() }), OutboundUrlError);
	assert.deepEqual(await postOneClickUnsubscribe("https://mixed.example/u", { pinnedPost: post }), {
		ok: false,
		reason: "refused_url",
	});
	await assert.rejects(post("ftp://news.example/u", { ...POST, signal: signal() }), OutboundUrlError);
	assert.equal(received.length, before);
});

test("one deadline covers the lookup: a late answer never starts the POST", async () => {
	const keepAlive = setTimeout(() => {}, 5_000);
	let release;
	const resolve = () => new Promise((resolveAddresses) => (release = () => resolveAddresses(["127.0.0.1"])));
	const post = createPinnedPost({ resolve, allowLoopback: true });
	const before = received.length;
	assert.deepEqual(
		await postOneClickUnsubscribe(`https://slow.example:${port}/u`, { pinnedPost: post, timeoutMs: 20 }),
		{
			ok: false,
			reason: "timeout",
		},
	);
	release();
	await new Promise((resolveWait) => setTimeout(resolveWait, 50));
	clearTimeout(keepAlive);
	assert.equal(received.length, before, "the late lookup did not connect");
});
