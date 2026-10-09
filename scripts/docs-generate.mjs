import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import prettier from "prettier";

export const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
export const inventoryPath = path.join(repositoryRoot, "docs/api-inventory.md");
const httpMethods = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);

export const openApiPath = path.join(repositoryRoot, "docs/openapi.json");
export const metricsRoutesPath = path.join(repositoryRoot, "src/lib/metrics-routes.generated.json");
const apiRoot = path.join(repositoryRoot, "src/app/api");

export async function listRouteFiles(directory = apiRoot) {
	const entries = await readdir(directory, { withFileTypes: true });
	const results = await Promise.all(
		entries.map(async (entry) => {
			const filename = path.join(directory, entry.name);
			if (entry.isDirectory()) return listRouteFiles(filename);
			return entry.name === "route.ts" ? [filename] : [];
		}),
	);
	return results.flat().sort();
}

async function parseSource(filename) {
	return ts.createSourceFile(filename, await readFile(filename, "utf8"), ts.ScriptTarget.Latest, true);
}

function exportedMethods(source, filename) {
	const methods = new Set();
	for (const statement of source.statements) {
		if (ts.isExportDeclaration(statement)) {
			if (!statement.exportClause) throw new Error(`Explicit HTTP exports required for inventory: ${filename}`);
			if (ts.isNamedExports(statement.exportClause)) {
				for (const entry of statement.exportClause.elements) {
					if (httpMethods.has(entry.name.text)) methods.add(entry.name.text);
				}
			}
		} else if (statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) {
			if (ts.isFunctionDeclaration(statement) && statement.name && httpMethods.has(statement.name.text)) {
				methods.add(statement.name.text);
			}
			if (ts.isVariableStatement(statement)) {
				for (const declaration of statement.declarationList.declarations) {
					if (ts.isIdentifier(declaration.name) && httpMethods.has(declaration.name.text))
						methods.add(declaration.name.text);
				}
			}
		}
	}
	if (!methods.size) throw new Error(`Route has no explicit HTTP handler: ${filename}`);
	return [...methods].sort();
}

export async function routeMethods(filename) {
	return exportedMethods(await parseSource(filename), filename);
}

/** Next.js style path, for example `/api/v1/domains/[id]`. */
export function routePath(filename) {
	const route = "/api/" + path.relative(apiRoot, path.dirname(filename)).split(path.sep).join("/");
	return route.replace(/\/$/, "");
}

export const toOpenApiPath = (route) => route.replace(/\[([^\]]+)\]/g, "{$1}");

export async function renderApiInventory() {
	const rows = [];
	for (const filename of await listRouteFiles(apiRoot)) {
		const methods = await routeMethods(filename);
		const relative = path.relative(repositoryRoot, filename).split(path.sep).join("/");
		rows.push(`| \`${routePath(filename)}\` | ${methods.join(", ")} | [source](../${relative}) |`);
	}
	const markdown =
		"# Generated API route inventory\n\n" +
		"Generated from explicit HTTP exports in `src/app/api/**/route.ts`.\n" +
		"Regenerate with `node scripts/docs-generate.mjs`; verify with `node scripts/docs-check.mjs`.\n\n" +
		"This is an implementation inventory. The public `/api/v1` surface is described by\n" +
		"[openapi.json](openapi.json); other routes' authentication, authorization,\n" +
		"request/response shapes and error behavior require source review\n" +
		"and [the API guide](api.md). It excludes `/mcp` and Worker email/queue entrypoints.\n" +
		"Implicit framework HEAD/OPTIONS behavior is not listed. The relay has a separate\n" +
		"`GET /health` liveness endpoint; it does not check upstream connectivity.\n\n" +
		"| Route | Explicit methods | Implementation |\n|---|---|---|\n" +
		rows.join("\n") +
		"\n";
	return prettier.format(markdown, { parser: "markdown", ...(await prettier.resolveConfig(inventoryPath)) });
}

function callName(node) {
	return ts.isCallExpression(node) && ts.isIdentifier(node.expression) ? node.expression.text : null;
}

function stringArg(node, index) {
	const arg = node.arguments[index];
	return arg && ts.isStringLiteralLike(arg) ? arg.text : null;
}

function topLevelFunctions(source) {
	const functions = new Map();
	for (const statement of source.statements) {
		if (ts.isFunctionDeclaration(statement) && statement.name) functions.set(statement.name.text, statement);
		if (ts.isVariableStatement(statement)) {
			for (const declaration of statement.declarationList.declarations) {
				if (ts.isIdentifier(declaration.name) && declaration.initializer)
					functions.set(declaration.name.text, declaration.initializer);
			}
		}
	}
	return functions;
}

/** Scopes, admin flag and status literals reachable from a handler through same-file helpers. */
function analyseHandler(functions, name) {
	const scopes = new Set();
	const statuses = new Set();
	let admin = false;
	const seen = new Set();
	const visit = (functionName) => {
		const node = functions.get(functionName);
		if (!node || seen.has(functionName)) return;
		seen.add(functionName);
		const walk = (child) => {
			const callee = callName(child);
			if (callee === "authenticateAdminApiKey") {
				const scope = stringArg(child, 2);
				if (scope) scopes.add(scope);
				admin = true;
			} else if (callee === "requireScope") {
				const scope = stringArg(child, 1);
				if (scope) scopes.add(scope);
			} else if (callee && functions.has(callee)) visit(callee);
			if (
				ts.isPropertyAssignment(child) &&
				ts.isIdentifier(child.name) &&
				child.name.text === "status" &&
				ts.isNumericLiteral(child.initializer)
			)
				statuses.add(Number(child.initializer.text));
			ts.forEachChild(child, walk);
		};
		walk(node);
	};
	visit(name);
	return { scopes: [...scopes], statuses: [...statuses], admin };
}

async function handlerFunctions(filename, source) {
	const functions = topLevelFunctions(source);
	for (const statement of source.statements) {
		if (
			ts.isExportDeclaration(statement) &&
			statement.moduleSpecifier &&
			ts.isStringLiteral(statement.moduleSpecifier) &&
			statement.moduleSpecifier.text.startsWith("./")
		) {
			const target = path.resolve(path.dirname(filename), statement.moduleSpecifier.text + ".ts");
			for (const [name, node] of topLevelFunctions(await parseSource(target))) {
				if (!functions.has(name)) functions.set(name, node);
			}
		}
	}
	return functions;
}

function operationFor(method, route, analysis, filename) {
	if (analysis.scopes.length !== 1)
		throw new Error(
			`${path.relative(repositoryRoot, filename)}: ${method} needs exactly one detectable scope (requireScope or authenticateAdminApiKey), found ${analysis.scopes.length}`,
		);
	const params = [...route.matchAll(/\{([^}]+)\}/g)].map((match) => ({
		name: match[1],
		in: "path",
		required: true,
		schema: { type: "string" },
	}));
	const success = analysis.statuses.includes(201) ? 201 : 200;
	const responses = {
		[success]: { description: "Success", content: { "application/json": { schema: { type: "object" } } } },
	};
	for (const status of [...new Set([401, ...analysis.statuses])].filter((code) => code >= 400).sort())
		responses[status] = { $ref: "#/components/responses/Error" };
	const operation = {
		operationId: `${method.toLowerCase()}${route
			.split("/")
			.filter((part) => part && part !== "api" && part !== "v1")
			.map((part) => part.replace(/[{}]/g, "").replace(/^./, (letter) => letter.toUpperCase()))
			.join("")}`,
		security: [{ bearerAuth: analysis.scopes }],
	};
	if (analysis.admin) operation["x-requires-admin"] = true;
	if (params.length) operation.parameters = params;
	if (["POST", "PUT", "PATCH"].includes(method))
		operation.requestBody = { content: { "application/json": { schema: { type: "object" } } } };
	operation.responses = responses;
	return operation;
}

export async function renderOpenApi() {
	const packageJson = JSON.parse(await readFile(path.join(repositoryRoot, "package.json"), "utf8"));
	const paths = {};
	for (const filename of await listRouteFiles(path.join(apiRoot, "v1"))) {
		const source = await parseSource(filename);
		const functions = await handlerFunctions(filename, source);
		const route = toOpenApiPath(routePath(filename));
		for (const method of exportedMethods(source, filename)) {
			paths[route] ??= {};
			paths[route][method.toLowerCase()] = operationFor(method, route, analyseHandler(functions, method), filename);
		}
	}
	const document = {
		openapi: "3.1.0",
		info: {
			title: "Kite API",
			version: packageJson.version,
			description: "Generated from src/app/api/v1/**/route.ts by scripts/docs-generate.mjs. See docs/api.md.",
		},
		servers: [{ url: "/" }],
		paths,
		components: {
			securitySchemes: {
				bearerAuth: {
					type: "http",
					scheme: "bearer",
					description:
						"API key from Settings → API keys (personal scopes: send, read, jmap, calendar:read, calendar:write) or Admin → API keys (admin scopes: domains, accounts, mailboxes; owner must keep the admin role). Scope lists: src/lib/api/scopes.ts.",
				},
			},
			responses: {
				Error: {
					description: "Error. Validation failures return the flattened Zod error in `error`.",
					content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
				},
			},
			schemas: {
				Error: {
					type: "object",
					required: ["error"],
					properties: {
						error: { oneOf: [{ type: "string" }, { $ref: "#/components/schemas/ValidationError" }] },
						code: { type: "string" },
						records: { type: "array", items: {} },
					},
				},
				ValidationError: {
					type: "object",
					properties: {
						formErrors: { type: "array", items: { type: "string" } },
						fieldErrors: {
							type: "object",
							additionalProperties: { type: "array", items: { type: "string" } },
						},
					},
				},
			},
		},
	};
	return prettier.format(JSON.stringify(document), { parser: "json", ...(await prettier.resolveConfig(openApiPath)) });
}

/** Route templates (`/api/v1/domains/[id]`) the metrics matcher maps concrete paths back to. */
export async function renderMetricsRoutes() {
	const templates = (await listRouteFiles()).map(routePath);
	return prettier.format(JSON.stringify(templates), {
		parser: "json",
		...(await prettier.resolveConfig(metricsRoutesPath)),
	});
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	await writeFile(inventoryPath, await renderApiInventory());
	await writeFile(openApiPath, await renderOpenApi());
	await writeFile(metricsRoutesPath, await renderMetricsRoutes());
	console.log(
		"Generated docs/api-inventory.md and docs/openapi.json and src/lib/metrics-routes.generated.json from HTTP route exports.",
	);
}
