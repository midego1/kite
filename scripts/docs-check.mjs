import { access, readFile } from "node:fs/promises";
import path from "node:path";
import {
	renderApiInventory,
	renderOpenApi,
	renderMetricsRoutes,
	inventoryPath,
	openApiPath,
	metricsRoutesPath,
	listRouteFiles,
	routeMethods,
	routePath,
	repositoryRoot,
} from "./docs-generate.mjs";
import { mentionedRepositoryPaths, mentionedRoutes, missingHeadings, routeExists } from "./docs-check-utils.mjs";

const failures = [];
const packageJson = JSON.parse(await readFile(path.join(repositoryRoot, "package.json"), "utf8"));
const contractDocs = [
	"AGENTS.md",
	"README.md",
	"docs/mission-readiness.md",
	"docs/operations.md",
	"docs/pii-handling.md",
	"docs/privacy.md",
	"docs/runbooks/incident.md",
	"docs/runbooks/mail-delivery.md",
	"docs/runbooks/recovery.md",
	"SECURITY.md",
	".factory/skills/validate-kite/SKILL.md",
];
const requiredHeadings = {
	"docs/operations.md": [
		"## After a deploy",
		"### Main Worker (kite)",
		"### Email relay (kite-email-relay)",
		"### Analytics Engine queries",
		"### Compare before and after",
	],
	"docs/privacy.md": ["## Controller", "## What is stored where", "## Retention", "## Export", "## Deletion"],
};
const apiRoutes = new Map();
for (const filename of await listRouteFiles()) apiRoutes.set(routePath(filename), await routeMethods(filename));
const requiredValidation = ["check", "build", "build:node", "test:relay:integration"];
const agents = await readFile(path.join(repositoryRoot, "AGENTS.md"), "utf8");
for (const command of requiredValidation) {
	if (!agents.includes(`npm run ${command}`)) failures.push(`AGENTS.md must document npm run ${command}`);
}
if (!agents.includes("playwright test")) failures.push("AGENTS.md must document browser validation");
if (!agents.includes("main") || !agents.includes("mission/")) failures.push("AGENTS.md must describe branch safety");
for (const filename of contractDocs) {
	const content = await readFile(path.join(repositoryRoot, filename), "utf8");
	for (const heading of missingHeadings(content, requiredHeadings[filename] ?? []))
		failures.push(`${filename}: missing heading ${heading}`);
	for (const mentioned of mentionedRepositoryPaths(content)) {
		try {
			await access(path.join(repositoryRoot, mentioned));
		} catch {
			failures.push(`${filename}: missing repository path ${mentioned}`);
		}
	}
	for (const { method, route } of mentionedRoutes(content)) {
		if (!routeExists(apiRoutes, method, route)) failures.push(`${filename}: unknown API route ${method} ${route}`);
	}
	for (const match of content.matchAll(/\bnpm run ([a-zA-Z0-9:_-]+)/g)) {
		if (!Object.hasOwn(packageJson.scripts, match[1])) failures.push(`${filename}: unknown npm command ${match[1]}`);
	}
	for (const match of content.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
		const target = match[1].replace(/^<|>$/g, "").split("#")[0];
		if (!target || /^[a-z][a-z0-9+.-]*:|^\//i.test(target)) continue;
		try {
			await access(path.resolve(repositoryRoot, path.dirname(filename), decodeURIComponent(target)));
		} catch {
			failures.push(`${filename}: broken local link ${target}`);
		}
	}
}
let storedInventory;
try {
	storedInventory = await readFile(inventoryPath, "utf8");
} catch {
	failures.push("Missing docs/api-inventory.md");
}
if (storedInventory !== (await renderApiInventory()))
	failures.push("API inventory stale; run node scripts/docs-generate.mjs");
let storedOpenApi;
try {
	storedOpenApi = await readFile(openApiPath, "utf8");
} catch {
	failures.push("Missing docs/openapi.json; run node scripts/docs-generate.mjs");
}
if (storedOpenApi !== undefined && storedOpenApi !== (await renderOpenApi()))
	failures.push("docs/openapi.json stale; run node scripts/docs-generate.mjs");
let storedMetricsRoutes;
try {
	storedMetricsRoutes = await readFile(metricsRoutesPath, "utf8");
} catch {
	failures.push("Missing src/lib/metrics-routes.generated.json; run node scripts/docs-generate.mjs");
}
if (storedMetricsRoutes !== undefined && storedMetricsRoutes !== (await renderMetricsRoutes()))
	failures.push(
		"Metrics route templates stale (src/lib/metrics-routes.generated.json); run node scripts/docs-generate.mjs",
	);
if (failures.length) {
	console.error(failures.join("\n"));
	process.exitCode = 1;
} else {
	console.log(`Documentation contracts passed (${contractDocs.length} guides; current API inventory).`);
}
