import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const directory = makeBundleDirectory("kite-current-email-hook-");
after(() => rmSync(directory, { recursive: true, force: true }));
await build({
	stdin: {
		contents: `
			export { useCurrentEmail } from "./src/components/agent/current-email.tsx";
			export { clearMessageDetailCache } from "./src/lib/messages/detail-cache.ts";
		`,
		resolveDir: root,
		sourcefile: "current-email-hook-entry.ts",
	},
	outfile: join(directory, "entry.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node22",
	packages: "external",
	tsconfig: join(root, "tsconfig.json"),
	logLevel: "silent",
});
const { useCurrentEmail, clearMessageDetailCache } = await import(pathToFileURL(join(directory, "entry.mjs")).href);

async function mount(t) {
	clearMessageDetailCache();
	const dom = new JSDOM("<div id='root'></div>");
	const previousGlobals = new Map();
	for (const [key, value] of Object.entries({
		window: dom.window,
		document: dom.window.document,
		IS_REACT_ACT_ENVIRONMENT: true,
	})) {
		previousGlobals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
		Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
	}
	let email;
	function CurrentEmail({ id }) {
		email = useCurrentEmail(id, "mailbox");
		return null;
	}
	const mounted = createRoot(dom.window.document.getElementById("root"));
	t.after(async () => {
		await act(() => mounted.unmount());
		dom.window.close();
		for (const [key, previous] of previousGlobals) {
			if (previous) Object.defineProperty(globalThis, key, previous);
			else delete globalThis[key];
		}
	});
	return {
		get email() {
			return email;
		},
		select: async (id) =>
			act(async () => {
				mounted.render(createElement(CurrentEmail, { id }));
			}),
	};
}

test("dismissal ends when another email opens, including when returning to the dismissed email", async (t) => {
	t.mock.method(globalThis, "fetch", async (url) =>
		Response.json({ message: { mailboxId: "mailbox", subject: String(url) } }),
	);
	const hook = await mount(t);
	await hook.select("email-a");
	assert.equal(hook.email.openEmailId, "email-a");
	await act(() => hook.email.dismiss());
	assert.equal(hook.email.ref.current, null);
	await hook.select("email-a");
	assert.equal(hook.email.openEmailId, null, "rerendering the same selection preserves dismissal");
	await hook.select("email-b");
	assert.equal(hook.email.openEmailId, "email-b");
	await hook.select("email-a");
	assert.equal(hook.email.openEmailId, "email-a");
	assert.equal(hook.email.ref.current, "email-a");
});
