// Local workerd -> HTTP receiver integration. Uses only synthetic mail/credentials.
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const secret = "local-relay-integration-only";
const received = [];
let decision = { action: "store", forwardTo: null };
const receiver = createServer(async (request, response) => {
	try {
		const chunks = [];
		for await (const chunk of request) chunks.push(chunk);
		const body = Buffer.concat(chunks);
		assert.equal(request.url, "/api/inbound");
		assert.equal(request.method, "POST");
		assert.match(request.headers.traceparent, /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
		const signature = createHmac("sha256", secret)
			.update(`${request.headers["x-kite-from"]}\n${request.headers["x-kite-to"]}\n`)
			.update(body)
			.digest("hex");
		assert.equal(request.headers["x-kite-signature"], signature);
		received.push(body.toString());
		response.writeHead(200, { "Content-Type": "application/json" });
		response.end(JSON.stringify(decision));
	} catch (error) {
		response.writeHead(500);
		response.end(String(error));
	}
});
receiver.listen(0, "127.0.0.1");
await once(receiver, "listening");
const receiverPort = receiver.address().port;
const reservation = createServer();
reservation.listen(0, "127.0.0.1");
await once(reservation, "listening");
const workerPort = reservation.address().port;
await new Promise((resolve) => reservation.close(resolve));
const child = spawn(
	process.execPath,
	[
		"node_modules/wrangler/bin/wrangler.js",
		"dev",
		"--config",
		"deploy/cloudflare-email-relay/wrangler.jsonc",
		"--local",
		"--ip",
		"127.0.0.1",
		"--port",
		String(workerPort),
		"--persist-to",
		".wrangler/relay-qa",
		"--var",
		`KITE_URL:http://127.0.0.1:${receiverPort}`,
		"--var",
		`INBOUND_WEBHOOK_SECRET:${secret}`,
	],
	{
		cwd: root,
		stdio: ["ignore", "pipe", "pipe"],
		env: { ...process.env, WRANGLER_SEND_METRICS: "false", BROWSER: "none" },
	},
);
let output = "";
try {
	await new Promise((resolve, reject) => {
		const timeout = setTimeout(() => reject(new Error(`Relay did not start: ${output}`)), 60_000);
		const observe = (chunk) => {
			output += chunk.toString();
			if (/Ready on http/.test(output)) {
				clearTimeout(timeout);
				resolve();
			}
		};
		child.stdout.on("data", observe);
		child.stderr.on("data", observe);
		child.once("error", (error) => {
			clearTimeout(timeout);
			reject(error);
		});
		child.once("exit", (code) => {
			clearTimeout(timeout);
			reject(new Error(`Relay exited (${code}): ${output}`));
		});
	});
	const healthy = await fetch(`http://127.0.0.1:${workerPort}/health`, { signal: AbortSignal.timeout(5000) });
	assert.deepEqual(await healthy.json(), { status: "ok", service: "kite-email-relay" });
	const url = `http://127.0.0.1:${workerPort}/cdn-cgi/handler/email?from=sender@example.com&to=inbox@example.com`;
	const mime =
		"From: sender@example.com\r\nTo: inbox@example.com\r\nSubject: Local relay QA\r\nMessage-ID: <relay-qa@example.com>\r\nDate: Wed, 07 Oct 2026 00:00:00 +0000\r\n\r\nSynthetic mail only.\r\n";
	const stored = await fetch(url, {
		method: "POST",
		headers: { "Content-Type": "message/rfc822" },
		body: mime,
		signal: AbortSignal.timeout(15_000),
	});
	assert.equal(stored.status, 200, await stored.text());
	assert.equal(received.length, 1);
	assert.equal(received[0], mime);
	decision = { action: "reject", reason: "Local QA rejection" };
	const rejected = await fetch(url, {
		method: "POST",
		headers: { "Content-Type": "message/rfc822" },
		body: mime,
		signal: AbortSignal.timeout(15_000),
	});
	const result = await rejected.text();
	assert.match(result, /Local QA rejection/);
	assert.equal(received.length, 2);
	console.log("Relay integration passed: real local workerd delivery, HMAC verification, store and reject routing.");
} finally {
	if (child.exitCode === null) {
		child.kill("SIGTERM");
		await Promise.race([
			once(child, "exit"),
			new Promise((resolve) =>
				setTimeout(() => {
					child.kill("SIGKILL");
					resolve();
				}, 5000).unref(),
			),
		]);
	}
	await new Promise((resolve) => receiver.close(resolve));
}
