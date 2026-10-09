import assert from "node:assert/strict";
import test from "node:test";
import { legacyStorageMigrationScript } from "../src/components/legacy-storage-utils.ts";

class MemoryStorage {
	constructor(entries = {}) {
		this.values = new Map(Object.entries(entries));
	}
	get length() {
		return this.values.size;
	}
	key(index) {
		return [...this.values.keys()][index] ?? null;
	}
	getItem(key) {
		return this.values.has(key) ? this.values.get(key) : null;
	}
	setItem(key, value) {
		this.values.set(key, String(value));
	}
	removeItem(key) {
		this.values.delete(key);
	}
}

function run(window) {
	new Function("window", legacyStorageMigrationScript)(window);
}

test("pre-rename keys move to the kite prefix in both storage areas", () => {
	const localStorage = new MemoryStorage({
		"mailflare-theme": "dark",
		"mailflare-column-width:sidebar:usr_1": "320",
		"mailflare:nav:layout": "compact",
		unrelated: "kept",
	});
	const sessionStorage = new MemoryStorage({ "mailflare-dashboard:assistant-open": "true" });
	run({ localStorage, sessionStorage });

	assert.deepEqual(Object.fromEntries(localStorage.values), {
		unrelated: "kept",
		"kite-theme": "dark",
		"kite-column-width:sidebar:usr_1": "320",
		"kite:nav:layout": "compact",
	});
	assert.deepEqual(Object.fromEntries(sessionStorage.values), { "kite-dashboard:assistant-open": "true" });
});

test("a value already stored under the kite key is not overwritten", () => {
	const localStorage = new MemoryStorage({ "kite-theme": "light", "mailflare-theme": "dark" });
	run({ localStorage, sessionStorage: new MemoryStorage() });
	assert.deepEqual(Object.fromEntries(localStorage.values), { "kite-theme": "light" });
});

test("unavailable storage does not stop the page", () => {
	const window = {
		get localStorage() {
			throw new Error("SecurityError");
		},
		sessionStorage: new MemoryStorage({ "mailflare-setup-token": "t" }),
	};
	run(window);
	assert.equal(window.sessionStorage.getItem("kite-setup-token"), "t");
});
