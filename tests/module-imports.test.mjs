import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, normalize, relative, sep } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const MODULE_IDS = ["calendar", "booking", "templates", "import", "finance", "drive"];

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
	"src/components/message-actions/",
	"src/components/settings/section-nav-utils.ts",
	"src/components/agent/agent-activity-utils.ts",
	"src/components/mailbox-selector.tsx",
	"src/components/message-attachment-card.tsx",
	"src/components/message-attachment-menu.tsx",
	"src/components/dashboard-section-shell.tsx",
	"src/app/api/settings/time-zone/route.ts",
	"src/app/api/accounts/create.ts",
	"src/app/api/auth/register/route.ts",
	"src/app/(dashboard)/import-export/page.tsx",
	"src/app/(settings)/settings/import-export/page.tsx",
	"src/lib/storage/",
	"src/lib/net/",
	"src/lib/imap/",
	// Connected accounts are core (spec §9.1): the import module reaches them only through moduleHost.accounts.
	"src/lib/external-accounts/",
	"src/app/api/external-accounts/",
	"src/app/(settings)/settings/connected-accounts/",
	"src/components/settings/connected-accounts/",
	"src/app/api/admin/storage/",
	"server/runtime/file-bucket.ts",
	"src/lib/backups/",
];

/** The calendar invite files that belong to the Calendar module's server code (spec §12). */
const MODULE_OWNED_INVITE_FILES = [
	"src/lib/agent/auto-read/invite.ts",
	"src/lib/agent/auto-read/invite-utils.ts",
	"src/lib/agent/auto-read/invite-actions-utils.ts",
	"src/lib/agent/auto-read/calendar-effects.ts",
	"src/lib/agent/auto-read/calendar-undo.ts",
	"src/lib/agent/auto-read/calendar-actions.ts",
	"src/lib/agent/auto-read/calendar-state.ts",
	"src/lib/agent/auto-read/invite-actions.ts",
	"src/lib/agent/auto-read/invite-proposal.ts",
];

/** Module code that core must not import, as path prefixes from the repo root. */
const MODULE_CODE = [
	"src/lib/calendar",
	"src/lib/booking",
	"src/lib/import",
	"src/lib/finance",
	"src/components/finance",
	"src/lib/drive",
	"src/components/drive",
	...MODULE_IDS.map((id) => `src/lib/modules/${id}`),
	...MODULE_IDS.map((id) => `src/components/modules/${id}`),
	...MODULE_OWNED_INVITE_FILES.map((file) => file.replace(/\.ts$/, "")),
];

/** Exceptions that stay allowed after the move. Each entry needs a written reason. Must stay empty. */
const ALLOWLIST = {};

/** Core files that still import module code until the change that moves them behind the registry lands. Must stay empty. */
const PENDING = {};

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

test("core files reach module code only through the registry", () => {
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

test("the allowlist and the pending list are empty", () => {
	assert.deepEqual(ALLOWLIST, {});
	assert.deepEqual(PENDING, {});
});

test("every core file in the list exists and is scanned", () => {
	for (const entry of CORE_PATHS) assert.ok(expand(entry).length > 0, `${entry} matches no file`);
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
	const files = [
		...walk(join(root, "src", "lib", "modules")),
		...walk(join(root, "src", "components", "modules")),
		...walk(join(root, "src", "lib", "finance")),
		...walk(join(root, "src", "components", "finance")),
		...walk(join(root, "src", "lib", "drive")),
		...walk(join(root, "src", "components", "drive")),
	].map((file) => toPosix(relative(root, file)));
	assert.ok(files.length > 0);
	for (const file of files)
		for (const path of importsOf(file))
			assert.ok(path !== "src/lib/email/send" && path !== "src/lib/email/webhooks", `${file} imports ${path}`);
});

test("Money Watch implementation code never loads code dynamically and stays out of automatic reading", () => {
	const files = [...walk(join(root, "src", "lib", "finance")), ...walk(join(root, "src", "lib", "modules", "finance"))];
	assert.ok(files.length > 0);
	for (const file of files)
		assert.ok(!/\bimport\(/.test(readFileSync(file, "utf8")), `${toPosix(relative(root, file))} uses import()`);
	const autoRead = walk(join(root, "src", "lib", "agent", "auto-read")).map((file) => toPosix(relative(root, file)));
	assert.deepEqual(
		autoRead.filter((file) => /finance|subscription/i.test(file)),
		[],
	);
});

test("Drive implementation code never loads code dynamically", () => {
	const files = [...walk(join(root, "src", "lib", "drive")), ...walk(join(root, "src", "lib", "modules", "drive"))];
	assert.ok(files.length > 0);
	for (const file of files)
		assert.ok(!/\bimport\(/.test(readFileSync(file, "utf8")), `${toPosix(relative(root, file))} uses import()`);
});

test("Money Watch reads attachments only through moduleHost.mail.readAttachment", () => {
	const files = [...walk(join(root, "src", "lib", "finance")), ...walk(join(root, "src", "lib", "modules", "finance"))];
	assert.ok(files.length > 0);
	const storage =
		/\bBUCKET\b|R2Bucket|message_attachments|messageAttachments|getAttachmentForUser|@\/lib\/email\/(?:attachments|inbound-attachments|shared-attachments|cloud-attachment-utils|module-read)\b/;
	const offenders = [];
	let reads = 0;
	for (const file of files) {
		const name = toPosix(relative(root, file));
		const source = readFileSync(file, "utf8");
		if (storage.test(source)) offenders.push(`${name} names attachment storage`);
		for (const path of importsOf(name))
			if (/^src\/lib\/email\/(?:attachments|inbound-attachments|shared-attachments|module-read)/.test(path))
				offenders.push(`${name} imports ${path}`);
		for (const match of source.matchAll(/([\w$.]*)readAttachment\b/g)) {
			if (match[1] === "moduleHost.mail.") reads += 1;
			else offenders.push(`${name} reads an attachment through ${match[0]}`);
		}
	}
	assert.deepEqual(offenders, []);
	assert.ok(reads > 0, "the PDF path reads its attachment through the host");
});

test("the import scanner resolves aliases, relative paths and dynamic imports", () => {
	assert.ok(importsOf("src/lib/modules/invoke.ts").includes("src/lib/modules/server-registry"));
	assert.ok(importsOf("src/lib/modules/invoke.ts").includes("src/lib/logger.mjs".replace(/\.mjs$/, "")));
	assert.ok(coreFiles.includes("worker.ts"));
	assert.ok(coreFiles.some((file) => file.startsWith("src/lib/agent/auto-read/")));
	assert.ok(!coreFiles.includes("src/lib/agent/auto-read/invite.ts"));
});
