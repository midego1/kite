import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { probeUpgrade, realtimeVerdict } from "../e2e/support/realtime-probe.mjs";

const upgraded = { kind: "upgraded" };
const reset = { kind: "reset" };

test("a reset is accepted only when the authenticated upgrade succeeds and plain requests answer 426", () => {
	assert.equal(realtimeVerdict({ plain: 426, anonymous: reset, authenticated: upgraded }), null);
	assert.equal(
		realtimeVerdict({ plain: 426, anonymous: { kind: "status", status: 401 }, authenticated: upgraded }),
		null,
	);
});

test("a reset without an accepted authenticated upgrade is a failure", () => {
	assert.match(realtimeVerdict({ plain: 426, anonymous: reset, authenticated: reset }), /authenticated/);
	assert.match(
		realtimeVerdict({ plain: 426, anonymous: reset, authenticated: { kind: "status", status: 500 } }),
		/authenticated/,
	);
});

test("a non-401 answer or an upgrade for an anonymous client fails", () => {
	for (const status of [200, 403, 500]) {
		assert.match(
			realtimeVerdict({ plain: 426, anonymous: { kind: "status", status }, authenticated: upgraded }),
			/anonymous/,
		);
	}
	assert.match(realtimeVerdict({ plain: 426, anonymous: upgraded, authenticated: upgraded }), /anonymous/);
});

test("a plain request that is not 426 fails", () => {
	assert.match(realtimeVerdict({ plain: 200, anonymous: reset, authenticated: upgraded }), /426/);
});

async function withServer(configure, run) {
	const server = createServer(configure.handler);
	server.on("upgrade", configure.upgrade ?? ((_req, socket) => socket.destroy()));
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	try {
		return await run(`http://127.0.0.1:${server.address().port}/api/realtime`);
	} finally {
		server.close();
		server.closeAllConnections();
	}
}

test("probeUpgrade classifies a hang-up, a status answer and an accepted upgrade", async () => {
	await withServer({ handler: () => {} }, async (url) => {
		assert.deepEqual(await probeUpgrade(url, {}), reset);
	});
	await withServer(
		{
			handler: () => {},
			upgrade: (_req, socket) => {
				socket.end("HTTP/1.1 500 Internal Server Error\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
			},
		},
		async (url) => {
			assert.deepEqual(await probeUpgrade(url, {}), { kind: "status", status: 500 });
		},
	);
	await withServer(
		{
			handler: () => {},
			upgrade: (_req, socket) => {
				socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
			},
		},
		async (url) => {
			assert.deepEqual(await probeUpgrade(url, {}), upgraded);
		},
	);
});

test("probeUpgrade rethrows errors that are not a hang-up", async () => {
	await assert.rejects(probeUpgrade("http://127.0.0.1:1/api/realtime", {}), /ECONNREFUSED/);
});
