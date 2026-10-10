import assert from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const bundleDirectory = makeBundleDirectory("kite-aws-credentials-panel-");
after(() => rmSync(bundleDirectory, { recursive: true, force: true }));
// Session routes read the cookie through next/headers, which needs a Next request scope; the shim serves the test's cookie.
const cookieShim = join(bundleDirectory, "next-headers-shim.mjs");
writeFileSync(
	cookieShim,
	`export async function cookies() {
		return { get: (name) => (globalThis.__awsTestCookie?.name === name ? globalThis.__awsTestCookie : undefined) };
	}`,
);
// The browser session helpers are not under test here; requestJson only needs a fetch that returns the stubbed response.
const authClientShim = join(bundleDirectory, "auth-client-shim.mjs");
writeFileSync(authClientShim, `export const authFetch = (input, init) => fetch(input, init);`);
await build({
	stdin: {
		contents: `
			export { SqliteDatabase } from "./server/runtime/sqlite-database.ts";
			export { applyMigrations } from "./server/runtime/migrate.ts";
			export { createSession } from "./src/lib/auth/session.ts";
			export { AWS_IAM_POLICY } from "./src/lib/aws/validate.ts";
			export { GET, PUT } from "./src/app/api/admin/aws/route.ts";
			export { ApiError, requestJson } from "./src/app/(admin)/domains/api.ts";
			export { missingPermissionsReport, refusedAwsSave } from "./src/app/(admin)/domains/aws-credentials-panel-utils.ts";
		`,
		resolveDir: root,
		sourcefile: "aws-credentials-panel-entry.ts",
	},
	outfile: join(bundleDirectory, "entry.mjs"),
	bundle: true,
	sourcemap: "inline",
	absWorkingDir: root,
	platform: "node",
	format: "esm",
	target: "node24",
	tsconfig: join(root, "tsconfig.json"),
	packages: "external",
	alias: {
		"next/headers": cookieShim,
		"@/lib/auth/client": authClientShim,
		"next/server": "next/server.js",
		"cloudflare:workers": "./server/runtime/cloudflare-workers.ts",
	},
	logLevel: "silent",
});
const {
	SqliteDatabase,
	applyMigrations,
	createSession,
	AWS_IAM_POLICY,
	GET,
	PUT,
	ApiError,
	requestJson,
	missingPermissionsReport,
	refusedAwsSave,
} = await import(pathToFileURL(join(bundleDirectory, "entry.mjs")).href);

const ORIGIN = "https://kite.test";
const CREDENTIALS = {
	accessKeyId: "AKIAIOSFODNN7EXAMPLE",
	secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
	region: "us-east-1",
};
const ACCESS_DENIED = "<ErrorResponse><Error><Code>AccessDenied</Code><Message>no</Message></Error></ErrorResponse>";

/** Answers AWS calls the way a key with no SES, SNS or S3 permissions would; local requests pass through. */
function mockAws(t, { identity = true } = {}) {
	const original = globalThis.fetch;
	globalThis.fetch = async (input, init = {}) => {
		const url = new URL(typeof input === "string" ? input : (input.url ?? input.href));
		if (!url.hostname.endsWith("amazonaws.com")) return original(input, init);
		const action = new URLSearchParams(typeof init.body === "string" ? init.body : "").get("Action");
		if (action === "GetCallerIdentity")
			return identity
				? new Response("<R><Account>123456789012</Account><Arn>arn:aws:iam::123456789012:user/kite</Arn></R>")
				: new Response(
						"<ErrorResponse><Error><Code>InvalidClientTokenId</Code><Message>bad</Message></Error></ErrorResponse>",
						{ status: 403 },
					);
		return new Response(ACCESS_DENIED, { status: 403 });
	};
	t.after(() => {
		globalThis.fetch = original;
	});
}

async function fixture(t) {
	const database = new SqliteDatabase(":memory:");
	t.after(() => database.db.close());
	await applyMigrations(database, join(root, "drizzle/migrations"));
	database.db.exec(`
		INSERT INTO users (id, email, password_hash, name, role, is_primary_admin, created_at) VALUES
			('owner', 'owner@one.test', 'hash', 'Owner', 'admin', 1, 1);
	`);
	const env = { DB: database, KITE_RUNTIME: "node" };
	globalThis.__kiteNodeEnv = env;
	globalThis.__awsTestCookie = { name: "ep_session", value: await createSession(env, "owner") };
	t.after(() => {
		delete globalThis.__kiteNodeEnv;
		delete globalThis.__awsTestCookie;
	});
	const call = async (handler, method, body) => {
		const init = { method, headers: { "Content-Type": "application/json", Origin: ORIGIN } };
		if (body !== undefined) init.body = JSON.stringify(body);
		const response = await handler(new Request(`${ORIGIN}/api/admin/aws`, init));
		return { status: response.status, json: await response.json() };
	};
	return { call };
}

const REPORT = {
	accountId: "123456789012",
	arn: "arn:aws:iam::123456789012:user/kite",
	region: "us-east-1",
	sending: false,
	productionAccess: null,
	receivingRegion: true,
	receiving: false,
	sns: false,
	s3: false,
	missing: ["ses:GetAccount", "ses:SendEmail"],
};

test("a save refused for missing SES permissions answers with the report and the IAM policy", async (t) => {
	const { call } = await fixture(t);
	mockAws(t);
	const refused = await call(PUT, "PUT", CREDENTIALS);
	assert.equal(refused.status, 400);
	assert.match(refused.json.error, /no SES permissions/);
	assert.equal(refused.json.report.sending, false);
	assert.ok(refused.json.report.missing.includes("ses:SendEmail"));
	assert.deepEqual(refused.json.policy, AWS_IAM_POLICY);
	assert.deepEqual(refusedAwsSave(refused.json), { report: refused.json.report, policy: AWS_IAM_POLICY });

	const status = await call(GET, "GET");
	assert.equal(status.json.status.configured, false, "refused credentials are not stored");
});

test("credentials AWS rejects outright carry no report", async (t) => {
	const { call } = await fixture(t);
	mockAws(t, { identity: false });
	const refused = await call(PUT, "PUT", CREDENTIALS);
	assert.equal(refused.status, 400);
	assert.match(refused.json.error, /AWS rejected these credentials/);
	assert.equal(refused.json.report, undefined);
	assert.equal(refusedAwsSave(refused.json), null);
});

function stubFetch(t, status, body) {
	const original = globalThis.fetch;
	globalThis.fetch = async () => Response.json(body, { status });
	t.after(() => {
		globalThis.fetch = original;
	});
}

test("requestJson keeps the parsed body and status on a rejected response", async (t) => {
	stubFetch(t, 400, { error: "nope", report: REPORT });
	const error = await requestJson("/api/admin/aws", "PUT", {}).then(
		() => null,
		(err) => err,
	);
	assert.ok(error instanceof ApiError);
	assert.ok(error instanceof Error, "callers that only read err.message keep working");
	assert.equal(error.message, "nope");
	assert.equal(error.status, 400);
	assert.deepEqual(error.data.report, REPORT);
});

test("requestJson falls back to a generic message and returns the body on success", async (t) => {
	stubFetch(t, 502, {});
	await assert.rejects(() => requestJson("/api/domains/d/ses", "GET"), { name: "ApiError", message: "Request failed" });
	stubFetch(t, 200, { ok: true });
	assert.deepEqual(await requestJson("/api/domains/d/ses", "GET"), { ok: true });
});

test("only bodies with a capability report count as a permission refusal", () => {
	assert.deepEqual(refusedAwsSave({ error: "x", report: REPORT }), { report: REPORT, policy: null });
	for (const body of [null, undefined, "text", {}, { report: null }, { report: { missing: "ses:GetAccount" } }])
		assert.equal(refusedAwsSave(body), null);
	assert.equal(refusedAwsSave({ report: { missing: [1] } }), null);
});

test("the missing-permission block follows a refused save, then saved credentials not being replaced", () => {
	const saved = { ...REPORT, sending: true, missing: ["s3:CreateBucket"] };
	const none = { ...REPORT, missing: [] };
	assert.equal(
		missingPermissionsReport({ refused: REPORT, report: null, configured: false, editing: false }),
		REPORT,
		"a refused first save shows its report while the form stays open",
	);
	assert.equal(missingPermissionsReport({ refused: REPORT, report: saved, configured: true, editing: true }), REPORT);
	assert.equal(missingPermissionsReport({ refused: null, report: saved, configured: true, editing: false }), saved);
	assert.equal(missingPermissionsReport({ refused: null, report: saved, configured: true, editing: true }), null);
	assert.equal(missingPermissionsReport({ refused: null, report: saved, configured: false, editing: false }), null);
	assert.equal(missingPermissionsReport({ refused: null, report: none, configured: true, editing: false }), null);
	assert.equal(missingPermissionsReport({ refused: none, report: null, configured: false, editing: false }), null);
});
