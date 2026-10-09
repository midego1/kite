import assert from "node:assert/strict";
import test from "node:test";
import {
	mentionedRepositoryPaths,
	mentionedRoutes,
	missingHeadings,
	routeExists,
} from "../scripts/docs-check-utils.mjs";

test("missingHeadings reports only absent whole-line headings", () => {
	const content = "# T\n\n## After a deploy\n\n### Main Worker (kite)\n";
	assert.deepEqual(missingHeadings(content, ["## After a deploy", "### Compare before and after"]), [
		"### Compare before and after",
	]);
	assert.deepEqual(missingHeadings("## After a deployment\n", ["## After a deploy"]), ["## After a deploy"]);
});

test("mentionedRepositoryPaths strips line suffixes and skips globs and placeholders", () => {
	const content =
		"`src/lib/auth/client.ts:66` `src/lib/**/*.ts` `src/app/api/[id]/route.ts` `inbound/<ts>.eml` `scripts/a.mjs:3-9` `npm run x`";
	assert.deepEqual(mentionedRepositoryPaths(content), [
		"src/lib/auth/client.ts",
		"src/app/api/[id]/route.ts",
		"scripts/a.mjs",
	]);
});

test("mentionedRoutes finds method and path pairs in backticks only", () => {
	const content = "`GET /api/setup/status` and `PATCH /api/accounts/[id]` but GET /api/plain and `GET /health`";
	assert.deepEqual(mentionedRoutes(content), [
		{ method: "GET", route: "/api/setup/status" },
		{ method: "PATCH", route: "/api/accounts/[id]" },
	]);
});

test("routeExists requires both the path and the method", () => {
	const routes = new Map([["/api/setup/status", ["GET"]]]);
	assert.equal(routeExists(routes, "GET", "/api/setup/status"), true);
	assert.equal(routeExists(routes, "PATCH", "/api/setup/status"), false);
	assert.equal(routeExists(routes, "GET", "/api/missing"), false);
});
