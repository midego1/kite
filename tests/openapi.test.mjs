import assert from "node:assert/strict";
import { readFile, mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
	listRouteFiles,
	routeMethods,
	routePath,
	toOpenApiPath,
	renderOpenApi,
	openApiPath,
	repositoryRoot,
} from "../scripts/docs-generate.mjs";

const document = JSON.parse(await readFile(openApiPath, "utf8"));
const v1Root = path.join(repositoryRoot, "src/app/api/v1");

async function sourceOperations() {
	const pairs = [];
	for (const filename of await listRouteFiles(v1Root)) {
		for (const method of await routeMethods(filename)) pairs.push(`${method} ${toOpenApiPath(routePath(filename))}`);
	}
	return pairs.sort();
}

test("document header", async () => {
	const version = (await readFile(path.join(repositoryRoot, "VERSION"), "utf8")).trim();
	assert.equal(document.openapi, "3.1.0");
	assert.equal(document.info.title, "Kite API");
	assert.equal(document.info.version, version);
	assert.deepEqual(document.servers, [{ url: "/" }]);
});

test("document operations equal the /api/v1 route methods", async () => {
	const documented = Object.entries(document.paths)
		.flatMap(([route, item]) => Object.keys(item).map((method) => `${method.toUpperCase()} ${route}`))
		.sort();
	const expected = await sourceOperations();
	assert.deepEqual(
		expected.filter((pair) => !documented.includes(pair)),
		[],
		"missing from docs/openapi.json",
	);
	assert.deepEqual(
		documented.filter((pair) => !expected.includes(pair)),
		[],
		"extra in docs/openapi.json",
	);
	assert.equal(expected.length, 17);
});

test("every operation has one scope, a 401 and a success response; path parameters are declared", () => {
	for (const [route, item] of Object.entries(document.paths)) {
		for (const [method, operation] of Object.entries(item)) {
			const label = `${method} ${route}`;
			const scopes = operation.security[0].bearerAuth;
			assert.equal(scopes.length, 1, label);
			assert.equal(operation.responses["401"].$ref, "#/components/responses/Error", label);
			assert.ok(operation.responses["200"] || operation.responses["201"], label);
			for (const [, name] of route.matchAll(/\{([^}]+)\}/g)) {
				assert.ok(
					operation.parameters.some((p) => p.name === name && p.in === "path" && p.required === true),
					label,
				);
			}
		}
	}
});

test("admin marking and scopes match the code", () => {
	for (const [route, item] of Object.entries(document.paths)) {
		for (const operation of Object.values(item)) {
			const admin = /^\/api\/v1\/(accounts|domains|mailboxes)/.test(route);
			assert.equal(operation["x-requires-admin"] === true, admin, route);
		}
	}
	assert.deepEqual(document.paths["/api/v1/messages"].get.security, [{ bearerAuth: ["read"] }]);
	assert.deepEqual(document.paths["/api/v1/send"].post.security, [{ bearerAuth: ["send"] }]);
	assert.ok(document.paths["/api/v1/domains/{id}/dns/setup"].post.responses["409"]);
});

test("error components describe the real shape", () => {
	const { Error: error, ValidationError } = document.components.schemas;
	assert.deepEqual(error.required, ["error"]);
	assert.equal(error.properties.error.oneOf[0].type, "string");
	assert.equal(error.properties.error.oneOf[1].$ref, "#/components/schemas/ValidationError");
	assert.equal(error.properties.code.type, "string");
	assert.equal(error.properties.records.type, "array");
	assert.ok(ValidationError.properties.formErrors && ValidationError.properties.fieldErrors);
	assert.equal(document.components.securitySchemes.bearerAuth.type, "http");
	assert.equal(document.components.securitySchemes.bearerAuth.scheme, "bearer");
});

test("committed document is current", async () => {
	assert.equal(await readFile(openApiPath, "utf8"), await renderOpenApi());
});

test("routePath keeps Next.js segments and toOpenApiPath converts them", () => {
	const file = path.join(v1Root, "domains/[id]/dns/route.ts");
	assert.equal(routePath(file), "/api/v1/domains/[id]/dns");
	assert.equal(toOpenApiPath(routePath(file)), "/api/v1/domains/{id}/dns");
});

test("generator refuses a v1 route without a scope", async () => {
	const dir = await mkdtemp(path.join(os.tmpdir(), "openapi-"));
	try {
		await mkdir(path.join(dir, "scripts"), { recursive: true });
		await mkdir(path.join(dir, "src/app/api/v1/zz"), { recursive: true });
		await writeFile(path.join(dir, "VERSION"), "2026.01.01.0\n");
		await writeFile(
			path.join(dir, "src/app/api/v1/zz/route.ts"),
			"export async function GET() { return new Response(); }\n",
		);
		const { cp } = await import("node:fs/promises");
		await cp(path.join(repositoryRoot, "scripts/docs-generate.mjs"), path.join(dir, "scripts/docs-generate.mjs"));
		await symlinkModules(dir);
		const { renderOpenApi: render } = await import(path.join(dir, "scripts/docs-generate.mjs"));
		await assert.rejects(render(), /zz\/route\.ts.*scope/);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

async function symlinkModules(dir) {
	const { symlink } = await import("node:fs/promises");
	await symlink(path.join(repositoryRoot, "node_modules"), path.join(dir, "node_modules"));
}
