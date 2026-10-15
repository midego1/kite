import assert from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = makeBundleDirectory("kite-realtime-module-notice-");
after(() => rmSync(outDir, { recursive: true, force: true }));

// The Durable Object base class only stores ctx and env; the hub's own fetch is what is under test.
const workersStub = join(outDir, "cloudflare-workers-stub.mjs");
writeFileSync(
	workersStub,
	"export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }\n",
);

async function load(entry, name) {
	const outfile = join(outDir, `${name}.mjs`);
	await build({
		entryPoints: [join(root, entry)],
		outfile,
		bundle: true,
		sourcemap: "inline",
		platform: "node",
		format: "esm",
		target: "node22",
		logLevel: "silent",
		alias: { "@": join(root, "src"), "cloudflare:workers": workersStub },
		external: ["react", "react-dom", "next", "next/*", "better-sqlite3", "ws"],
	});
	return import(pathToFileURL(outfile).href);
}

const { parseModuleNoticeEvent, MODULE_NOTICE_EVENT } = await load(
	"src/hooks/message-realtime-utils.ts",
	"message-realtime-utils",
);
const { notifyUsersOfNewMessage } = await load("src/lib/realtime/utils.ts", "realtime-utils");
const { RealtimeHubRegistry } = await load("server/runtime/realtime.ts", "node-realtime");
globalThis.WebSocketRequestResponsePair ??= class {
	constructor(request, response) {
		this.request = request;
		this.response = response;
	}
};
const { RealtimeHub } = await load("src/lib/realtime/hub.ts", "realtime-hub");

const NOTICE = {
	type: "module_notice",
	moduleId: "finance",
	notice: "renewal_due",
	title: "Streamly renews in 3 days ($17.99)",
	body: null,
	href: "/finance?subscription=sub-1",
};

function fakeSocket() {
	const sent = [];
	return { sent, send: (message) => sent.push(message), on: () => undefined, close: () => undefined };
}

test("the module notice event name is kite:module-notice", () => {
	assert.equal(MODULE_NOTICE_EVENT, "kite:module-notice");
});

test("parseModuleNoticeEvent keeps a well-formed notice", () => {
	assert.deepEqual(parseModuleNoticeEvent(JSON.stringify(NOTICE)), NOTICE);
	assert.deepEqual(parseModuleNoticeEvent(JSON.stringify({ ...NOTICE, body: "Plan Pro", href: undefined })), {
		...NOTICE,
		body: "Plan Pro",
		href: null,
	});
});

test("parseModuleNoticeEvent rejects other payloads, missing fields and links off this site", () => {
	assert.equal(parseModuleNoticeEvent("not json"), null);
	assert.equal(parseModuleNoticeEvent("null"), null);
	assert.equal(parseModuleNoticeEvent(JSON.stringify({ ...NOTICE, type: "new_message" })), null);
	assert.equal(parseModuleNoticeEvent(JSON.stringify({ ...NOTICE, moduleId: 3 })), null);
	assert.equal(parseModuleNoticeEvent(JSON.stringify({ ...NOTICE, notice: "" })), null);
	assert.equal(parseModuleNoticeEvent(JSON.stringify({ ...NOTICE, title: "" })), null);
	assert.equal(parseModuleNoticeEvent(JSON.stringify({ ...NOTICE, title: 5 })), null);
	for (const href of ["https://example.com/x", "//example.com", "/\\example.com", "javascript:alert(1)"])
		assert.equal(parseModuleNoticeEvent(JSON.stringify({ ...NOTICE, href })), null, href);
	assert.deepEqual(parseModuleNoticeEvent(JSON.stringify({ ...NOTICE, body: 7 })), { ...NOTICE, body: null });
});

test("the Node hub delivers a module notice to every open socket of the user only", async () => {
	const registry = new RealtimeHubRegistry();
	const [first, second, other] = [fakeSocket(), fakeSocket(), fakeSocket()];
	registry.attach("owner", first);
	registry.attach("owner", second);
	registry.attach("someone-else", other);
	await notifyUsersOfNewMessage({ REALTIME: registry.namespace() }, ["owner"], NOTICE);
	for (const socket of [first, second]) {
		assert.equal(socket.sent.length, 1);
		assert.deepEqual(parseModuleNoticeEvent(socket.sent[0]), NOTICE);
	}
	assert.deepEqual(other.sent, []);
});

test("the Durable Object hub delivers a module notice to its sockets", async () => {
	const sockets = [fakeSocket(), fakeSocket()];
	const ctx = { getWebSockets: () => sockets, setWebSocketAutoResponse: () => undefined };
	const hubs = new Map();
	// A Durable Object stub's fetch takes fetch() arguments and hands the object a Request.
	const namespace = {
		getByName(userId) {
			if (!hubs.has(userId)) hubs.set(userId, new RealtimeHub(ctx, {}));
			const hub = hubs.get(userId);
			return { fetch: (input, init) => hub.fetch(new Request(input, init)) };
		},
	};
	await notifyUsersOfNewMessage({ REALTIME: namespace }, ["owner"], NOTICE);
	assert.deepEqual([...hubs.keys()], ["owner"]);
	for (const socket of sockets) assert.deepEqual(parseModuleNoticeEvent(socket.sent[0]), NOTICE);
});
