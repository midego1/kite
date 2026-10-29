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

test("a session check is retried twice, after 1 and 2 seconds, for timeouts, network failures and 5xx", () => {
	const timeout = new DOMException("The operation timed out.", "TimeoutError");
	const network = new TypeError("Failed to fetch");
	const serverError = Object.assign(new Error("Session check failed with 503"), { status: 503 });
	for (const error of [timeout, network, serverError, { status: 429 }, { status: 408 }]) {
		assert.equal(helpers.shouldRetryAuthMe(0, error), true);
		assert.equal(helpers.shouldRetryAuthMe(1, error), true);
		assert.equal(helpers.shouldRetryAuthMe(2, error), false);
	}
	// Other client errors would answer the same again.
	for (const status of [400, 403, 404]) assert.equal(helpers.shouldRetryAuthMe(0, { status }), false);
	assert.deepEqual([0, 1, 2, 5].map(helpers.authMeRetryDelay), [1_000, 2_000, 2_000, 2_000]);
	// All three attempts and the waits between them end within 30 seconds, so the error state is never far off.
	const worstCase = helpers.AUTH_ME_TIMEOUT_MS * 3 + 1_000 + 2_000;
	assert.ok(worstCase <= 30_000, `${worstCase} ms`);
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
