import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, normalize, relative, sep } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const MODULE_IDS = ["calendar", "booking", "templates", "import"];

/** Core entry points and surfaces that must reach modules only through the registry (spec §19.1). */
const CORE_PATHS = [
	"worker.ts",
	"worker-utils.ts",
	"server/index.ts",
	"server/runtime/scheduler.ts",
	"src/lib/agent/chat.ts",
	"src/lib/agent/model.ts",
	"src/lib/agent/tools.ts",
	"src/lib/mcp/server.ts",
	"src/lib/mcp/auth.ts",
	"src/lib/email/webhooks.ts",
	"src/app/api/search/route.ts",
	"src/app/api/messages/route.ts",
	"src/lib/jmap/processor.ts",
	"src/lib/agent/auto-read/",
	"src/app/(dashboard)/for-you/",
	"src/components/shortcuts/",
	"src/components/compose/",
	"src/components/settings/section-nav-utils.ts",
	"src/components/agent/agent-activity-utils.ts",
	"src/components/mailbox-selector.tsx",
	"src/app/api/settings/time-zone/route.ts",
	"src/app/api/accounts/create.ts",
	"src/app/api/auth/register/route.ts",
	"src/app/(dashboard)/import-export/page.tsx",
	"src/app/(settings)/settings/import-export/page.tsx",
];

/** The calendar invite files that belong to the Calendar module's server code (spec §12). */
const MODULE_OWNED_INVITE_FILES = [
	"src/lib/agent/auto-read/invite.ts",
	"src/lib/agent/auto-read/invite-utils.ts",
	"src/lib/agent/auto-read/invite-actions-utils.ts",
	"src/lib/agent/auto-read/calendar-effects.ts",
	"src/lib/agent/auto-read/calendar-undo.ts",
];

/** Module code that core must not import, as path prefixes from the repo root. */
const MODULE_CODE = [
	"src/lib/calendar",
	"src/lib/booking",
	"src/lib/import",
	...MODULE_IDS.map((id) => `src/lib/modules/${id}`),
	...MODULE_IDS.map((id) => `src/components/modules/${id}`),
	"src/components/compose/template-menu",
	"src/components/compose/new-template-dialog",
	"src/components/compose/template-types",
	...MODULE_OWNED_INVITE_FILES.map((file) => file.replace(/\.ts$/, "")),
];

/** Exceptions that stay allowed after the move. Each entry needs a written reason. Must stay empty. */
const ALLOWLIST = {};

/**
 * Core files that still import module code because the change that moves them behind the registry
 * has not landed yet. Each later change deletes its entries; the list must end empty.
 */
const PENDING = {
	"worker.ts":
		"The queue and cron handlers still call the import job code by hand until dispatchModuleQueueMessage and runModuleCronTasks replace them (queue and cron routing feature).",
	"server/index.ts":
		"The Node queue consumer still calls the import job code by hand until dispatchModuleQueueMessage replaces it (queue and cron routing feature).",
	"src/lib/mcp/server.ts":
		"MCP still registers the calendar tools from the calendar library until it reads the registry's mcp_tool descriptors (MCP surface feature).",
	"src/lib/agent/auto-read/action-effects.ts":
		"Automatic reading still imports calendar undo directly until invite actions run through invoke (automatic reading feature).",
	"src/lib/agent/auto-read/calendar-state.ts":
		"This file belongs to the calendar invite actions and still imports their helpers; it moves behind the Calendar module with them (automatic reading feature).",
	"src/lib/agent/auto-read/execute.ts":
		"The action executor still imports calendar undo directly until undo runs through invoke (automatic reading feature).",
	"src/lib/agent/auto-read/invite-actions.ts":
		"The invite actions are Calendar module code that still lives here; they move behind the Calendar module's action descriptors (automatic reading feature).",
	"src/lib/agent/auto-read/invite-proposal.ts":
		"The proposal intro belongs to the invite actions and still imports their helpers; it moves behind the Calendar module with them (automatic reading feature).",
	"src/lib/agent/auto-read/process.ts":
		"Triage still calls the calendar invite step directly until it runs the registry's triage_step descriptors (automatic reading feature).",
	"src/components/compose/new-template-dialog.tsx":
		"The New template dialog is Templates module UI that still sits in the composer folder; it moves to src/components/modules/templates (composer slot feature).",
	"src/components/compose/schedule-send-menu.tsx":
		"The send menu still mounts the template menu and dialog directly until it renders the composer slot (composer slot feature).",
	"src/components/compose/template-menu.tsx":
		"The Template submenu is Templates module UI that still sits in the composer folder; it moves to src/components/modules/templates (composer slot feature).",
	"src/app/api/accounts/create.ts":
		"Account creation still assigns the booking username itself until the user.created lifecycle hook does it (lifecycle feature).",
	"src/app/api/auth/register/route.ts":
		"Registration still assigns the booking username itself until the user.created lifecycle hook does it (lifecycle feature).",
};

const toPosix = (path) => path.split(sep).join("/");

function walk(directory) {
	if (!existsSync(directory)) return [];
	return readdirSync(directory).flatMap((name) => {
		const path = join(directory, name);
		if (statSync(path).isDirectory()) return name === "node_modules" ? [] : walk(path);
		return /\.(ts|tsx|mjs)$/.test(name) && !name.endsWith(".d.ts") ? [path] : [];
	});
}

function expand(entry) {
	const path = join(root, entry);
	if (!entry.endsWith("/")) return existsSync(path) ? [entry] : [];
	return walk(path).map((file) => toPosix(relative(root, file)));
}

const SPECIFIER =
	/(?:^|[\s;{}])(?:import|export)\b(?:[^"'`;]*?\bfrom\s*)?\s*["']([^"']+)["']|\bimport\(\s*["']([^"']+)["']\s*\)/g;

/** Every module specifier a source file loads, resolved to a repo-relative path without extension. */
function importsOf(file) {
	const source = readFileSync(join(root, file), "utf8");
	const found = [];
	for (const match of source.matchAll(SPECIFIER)) {
		const specifier = match[1] ?? match[2];
		if (specifier.startsWith("@/")) found.push(`src/${specifier.slice(2)}`);
		else if (specifier.startsWith("."))
			found.push(toPosix(normalize(join(dirname(file), specifier))).replace(/^\.\//, ""));
	}
	return found.map((path) => path.replace(/\.(ts|tsx|mjs)$/, "").replace(/\/index$/, ""));
}

const covers = (prefix, path) => path === prefix || path.startsWith(`${prefix}/`);

function moduleImports(file) {
	return importsOf(file).filter((path) => MODULE_CODE.some((prefix) => covers(prefix, path)));
}

const coreFiles = [...new Set(CORE_PATHS.flatMap(expand))].filter((file) => !MODULE_OWNED_INVITE_FILES.includes(file));

test("only invoke.ts imports the server registry, and only the server registry imports a module's server.ts", () => {
	const importersOf = (target) =>
		walk(join(root, "src"))
			.map((file) => toPosix(relative(root, file)))
			.filter((file) => importsOf(file).includes(target));
	assert.deepEqual(importersOf("src/lib/modules/server-registry"), ["src/lib/modules/invoke.ts"]);
	for (const id of MODULE_IDS)
		assert.deepEqual(importersOf(`src/lib/modules/${id}/server`), ["src/lib/modules/server-registry.ts"], id);
});

test("core files reach module code only through the registry, apart from the pending list", () => {
	const violations = {};
	for (const file of coreFiles) {
		const found = moduleImports(file);
		if (found.length) violations[file] = found;
	}
	const unexpected = Object.entries(violations).filter(([file]) => !(file in PENDING) && !(file in ALLOWLIST));
	assert.deepEqual(
		unexpected.map(([file, found]) => `${file} imports ${[...new Set(found)].join(", ")}`),
		[],
	);
});

test("pending entries are real: each names a core file that still imports module code and gives a reason", () => {
	for (const [file, reason] of Object.entries(PENDING)) {
		assert.ok(coreFiles.includes(file), `${file} is not a core file in the list`);
		assert.ok(typeof reason === "string" && reason.length > 20, `${file} needs a written reason`);
		assert.ok(moduleImports(file).length > 0, `${file} no longer imports module code; delete its pending entry`);
	}
});

test("the allowlist is empty", () => {
	assert.deepEqual(ALLOWLIST, {});
});

test("core client code reaches module client code only through client-registry.ts", () => {
	const moduleOwned = (file) => MODULE_IDS.some((id) => file.startsWith(`src/components/modules/${id}/`));
	const offenders = walk(join(root, "src"))
		.map((file) => toPosix(relative(root, file)))
		.filter((file) => file !== "src/components/modules/client-registry.ts" && !moduleOwned(file))
		.filter((file) =>
			importsOf(file).some((path) => MODULE_IDS.some((id) => covers(`src/components/modules/${id}`, path))),
		);
	assert.deepEqual(offenders, []);
});

test("module directories never import the send path or the webhook dispatcher directly", () => {
	const files = [...walk(join(root, "src", "lib", "modules")), ...walk(join(root, "src", "components", "modules"))].map(
		(file) => toPosix(relative(root, file)),
	);
	assert.ok(files.length > 0);
	for (const file of files)
		for (const path of importsOf(file))
			assert.ok(path !== "src/lib/email/send" && path !== "src/lib/email/webhooks", `${file} imports ${path}`);
});

test("the import scanner resolves aliases, relative paths and dynamic imports", () => {
	assert.ok(importsOf("src/lib/modules/invoke.ts").includes("src/lib/modules/server-registry"));
	assert.ok(importsOf("src/lib/modules/invoke.ts").includes("src/lib/logger.mjs".replace(/\.mjs$/, "")));
	assert.ok(coreFiles.includes("worker.ts"));
	assert.ok(coreFiles.some((file) => file.startsWith("src/lib/agent/auto-read/")));
	assert.ok(!coreFiles.includes("src/lib/agent/auto-read/invite.ts"));
});
