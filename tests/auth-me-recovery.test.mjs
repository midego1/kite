import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const bundleDirectory = makeBundleDirectory("kite-auth-me-recovery-");
after(() => rmSync(bundleDirectory, { recursive: true, force: true }));
await build({
	stdin: {
		contents: [
			`export * from "./src/lib/auth/me-client-utils.ts";`,
			`export { getAuthGuardDecision } from "./src/components/auth/auth-guard-utils.ts";`,
		].join("\n"),
		resolveDir: root,
		sourcefile: "auth-me-recovery-test-entry.js",
	},
	outfile: join(bundleDirectory, "auth-me.mjs"),
	bundle: true,
	sourcemap: "inline",
	platform: "node",
	format: "esm",
	target: "node24",
	tsconfig: join(root, "tsconfig.json"),
	absWorkingDir: root,
	logLevel: "silent",
});
const helpers = await import(pathToFileURL(join(bundleDirectory, "auth-me.mjs")).href);

test("a session check is retried twice for network failures and 5xx, once for a timeout, with a shorter timeout", () => {
	const timeout = new DOMException("The operation timed out.", "TimeoutError");
	const network = new TypeError("Failed to fetch");
	const serverError = Object.assign(new Error("Session check failed with 503"), { status: 503 });
	for (const error of [network, serverError, { status: 429 }, { status: 408 }]) {
		assert.equal(helpers.shouldRetryAuthMe(0, error), true);
		assert.equal(helpers.shouldRetryAuthMe(1, error), true);
		assert.equal(helpers.shouldRetryAuthMe(2, error), false);
	}
	assert.equal(helpers.shouldRetryAuthMe(0, timeout), true);
	assert.equal(helpers.shouldRetryAuthMe(1, timeout), false);
	// Other client errors would answer the same again.
	for (const status of [400, 403, 404]) assert.equal(helpers.shouldRetryAuthMe(0, { status }), false);
	assert.deepEqual([0, 1, 2, 5].map(helpers.authMeRetryDelay), [1_000, 2_000, 2_000, 2_000]);
	assert.deepEqual([0, 1, 2].map(helpers.authMeTimeoutMs), [6_000, 4_000, 4_000]);
	// A check that keeps hanging reaches the error state after 6 + 1 + 4 seconds.
	const hanging = helpers.authMeTimeoutMs(0) + helpers.authMeRetryDelay(0) + helpers.authMeTimeoutMs(1);
	assert.equal(hanging, 11_000);
});

test("auth guard: a failed check without an answer shows the error state, not a loader", () => {
	const session = { user: { role: "user", isPrimaryAdmin: false }, hasMailboxes: true, isSetup: true };
	const base = { mode: "protected", status: "error", session: undefined, pathname: "/inbox" };
	assert.deepEqual(helpers.getAuthGuardDecision(base), { authorized: false, redirect: null, unreachable: true });
	// Public pages (sign-in) still render.
	assert.deepEqual(helpers.getAuthGuardDecision({ ...base, mode: "public" }), { authorized: true, redirect: null });
	// A failed refetch keeps the last answer, which decides as usual.
	assert.deepEqual(helpers.getAuthGuardDecision({ ...base, session }), { authorized: true, redirect: null });
	assert.deepEqual(helpers.getAuthGuardDecision({ ...base, session: null }), { authorized: false, redirect: "/login" });
	assert.deepEqual(helpers.getAuthGuardDecision({ ...base, session, requireRole: "admin" }), {
		authorized: false,
		redirect: "/inbox",
	});
	// "Continue anyway" renders without a session, also while a later attempt is pending.
	for (const status of ["error", "pending"]) {
		assert.deepEqual(helpers.getAuthGuardDecision({ ...base, status, continueWithoutSession: true }), {
			authorized: true,
			redirect: null,
		});
	}
	// Once an answer arrives it decides, so a signed-out session still goes to /login.
	assert.deepEqual(
		helpers.getAuthGuardDecision({ ...base, status: "success", session: null, continueWithoutSession: true }),
		{ authorized: false, redirect: "/login" },
	);
});
