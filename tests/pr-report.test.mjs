import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	REPORT_MARKER,
	checkRepoRules,
	parseMigrationTableChanges,
	parseSemgrep,
	renderCoverage,
	renderQuality,
	renderReport,
	semgrepOutcome,
	auditOutcome,
	renderRepoRules,
	renderSecurity,
	summarizeAudit,
	summarizeCoverage,
	summarizeQuality,
} from "../scripts/review/pr-report-utils.mjs";

const fixtures = new URL("./fixtures/pr-report/", import.meta.url).pathname;
const fixture = (name) => JSON.parse(readFileSync(join(fixtures, name), "utf8"));

test("semgrep findings keep file:line, rule, severity and message only", () => {
	const findings = parseSemgrep(fixture("semgrep.json"));
	assert.deepEqual(findings[0], {
		rule: "kite.no-eval",
		severity: "ERROR",
		file: "src/lib/changed-file.ts",
		line: 12,
		message: "Do not use eval.",
	});
	assert.equal(findings[1].message, "Weak hash in use.");
	assert.ok(!JSON.stringify(findings).includes("SNIPPET_SENTINEL"));
});

test("security section marks changed files and omits snippets and via details", () => {
	const audit = summarizeAudit(fixture("audit-head.json"), fixture("audit-base.json"));
	const text = renderSecurity({
		semgrep: parseSemgrep(fixture("semgrep.json")),
		audit,
		changedFiles: ["src/lib/changed-file.ts"],
	});
	assert.match(
		text,
		/`src\/lib\/changed-file\.ts:12` ERROR `kite\.no-eval`: Do not use eval\. \*\*\(changed in this PR\)\*\*/,
	);
	assert.doesNotMatch(text, /untouched\.ts:40.*changed in this PR/);
	assert.match(text, /Head: 0 critical, 1 high, 0 moderate, 1 low\./);
	assert.match(text, /`left-pad` high https:\/\/github\.com\/advisories\/GHSA-aaaa-bbbb-cccc/);
	assert.doesNotMatch(text, /old-lib/);
	assert.doesNotMatch(text, /SNIPPET_SENTINEL|VIA_SENTINEL/);
});

test("audit summary lists fixable packages and treats a missing base as all new", () => {
	const summary = summarizeAudit(fixture("audit-head.json"), null);
	assert.deepEqual(summary.fixable, ["left-pad"]);
	assert.equal(summary.newAdvisories.length, 2);
	assert.equal(summary.newAdvisories[0].name, "left-pad");
});

test("quality section lists new debt with value and baseline and task marker counts", () => {
	const key = "lint:src/a.ts:complexity:Function 'a' has a complexity.:occurrence=1";
	const quality = summarizeQuality(fixture("quality-summary.json"), fixture("todos.json"), { [key]: 20 });
	assert.deepEqual(quality.newDebt, [{ key, value: 25, baseline: 20 }]);
	assert.equal(quality.unlinkedTodos, 2);
	assert.equal(quality.linkedTodos, 1);
	const text = renderQuality(quality);
	assert.match(text, /\| 25 \| 20 \|/);
	assert.match(text, /TODOs: 2 unlinked, 1 linked\./);
	assert.equal(renderQuality(null), "_not run_");
	assert.match(renderQuality(summarizeQuality({ newDebt: [] }, null)), /TODOs: not run/);
});

test("coverage section shows aggregate and each gated file against its thresholds", () => {
	const text = renderCoverage(summarizeCoverage(fixture("coverage-summary.json")));
	assert.match(text, /lines 86\.9%, branches 94\.1%, functions 99\.1%/);
	assert.match(
		text,
		/`src\/lib\/logger\.mjs` \| 100% \| 90\.5% \| 100% \| lines 90, branches 80, functions 90 \| pass/,
	);
	assert.match(text, /`src\/lib\/weak-utils\.ts`.*FAIL/);
	assert.equal(renderCoverage(null), "_not run_");
});

test("R1 ignores a Drizzle rebuild sequence and CREATE VIRTUAL TABLE", () => {
	const sql = [
		"CREATE TABLE `__new_t` (id text);",
		"INSERT INTO `__new_t` SELECT id FROM `t`;",
		"DROP TABLE `t`;",
		"ALTER TABLE `__new_t` RENAME TO `t`;",
		"CREATE VIRTUAL TABLE messages_fts USING fts5(subject);",
	].join("\n");
	assert.deepEqual(parseMigrationTableChanges(sql), { created: [], dropped: [], renamed: [] });
	assert.deepEqual(
		parseMigrationTableChanges(
			"CREATE TABLE IF NOT EXISTS `a` (id text);\nDROP TABLE IF EXISTS b;\nALTER TABLE c RENAME TO d;",
		),
		{
			created: ["a"],
			dropped: ["b"],
			renamed: [{ from: "c", to: "d" }],
		},
	);
});

const noFiles = () => null;
const rule = (rules, id) => rules.find((entry) => entry.id === id);
const migration = (path, sql) => ({ changes: [{ status: "A", path }], readHead: (p) => (p === path ? sql : null) });

test("R1 passes for a rebuild-only migration", () => {
	const { changes, readHead } = migration(
		"drizzle/migrations/0100_x.sql",
		"CREATE TABLE `__new_t` (a);\nDROP TABLE `t`;\nALTER TABLE `__new_t` RENAME TO `t`;",
	);
	assert.equal(rule(checkRepoRules({ changes, readBase: noFiles, readHead }), "R1").status, "pass");
});

test("R1 warns for a new table without backup list changes", () => {
	const { changes, readHead } = migration(
		"drizzle/migrations/0100_x.sql",
		"CREATE TABLE `val_probe` (id text primary key);",
	);
	const r1 = rule(checkRepoRules({ changes, readBase: noFiles, readHead }), "R1");
	assert.equal(r1.status, "warn");
	assert.match(r1.details.join("\n"), /val_probe/);
});

test("R1 warns when a created table is missing from export.ts even if the file changed", () => {
	const path = "drizzle/migrations/0100_x.sql";
	const readHead = (p) =>
		p === path
			? "CREATE TABLE val_probe (id text);"
			: p === "src/lib/backups/export.ts"
				? "BACKUP_TABLES = ['users']"
				: null;
	const changes = [
		{ status: "A", path },
		{ status: "M", path: "src/lib/backups/export.ts" },
	];
	const details = rule(checkRepoRules({ changes, readBase: noFiles, readHead }), "R1").details;
	assert.equal(details.length, 1);
	assert.match(details[0], /`val_probe` is not listed/);
});

const EXPORT = "src/lib/backups/export.ts";
const GROUPS = "src/lib/backups/table-groups.ts";
const TYPES = "src/lib/backups/types.d.ts";
const backupFiles = ({ exportText, groups, types }) => ({
	[EXPORT]: exportText,
	[GROUPS]: groups,
	[TYPES]: types,
});
const r1For = (sql, files) => {
	const path = "drizzle/migrations/0100_x.sql";
	const readHead = (p) => (p === path ? sql : (files[p] ?? null));
	const changes = [{ status: "A", path }, ...Object.keys(files).map((file) => ({ status: "M", path: file }))];
	return rule(checkRepoRules({ changes, readBase: noFiles, readHead }), "R1");
};
const listed = (name) =>
	backupFiles({
		exportText: `const BACKUP_TABLES: DatabaseBackupTable[] = [\n\t"users",\n\t"${name}",\n];\nconst INTERNAL_TABLES = ["d1_migrations"];`,
		groups: `export const BACKUP_TABLE_GROUPS: X[] = [\n\t{ id: "a", tables: ["users", "${name}"] },\n];`,
		types: `export type DatabaseBackupTable =\n\t| "users"\n\t| "${name}";`,
	});

test("R1 passes when the created table is listed exactly in all backup lists", () => {
	assert.equal(r1For("CREATE TABLE val_probe (id text);", listed("val_probe")).status, "pass");
});

test("R1 passes for a table in INTERNAL_TABLES alone", () => {
	const files = backupFiles({
		exportText: 'const BACKUP_TABLES = ["users"];\nconst INTERNAL_TABLES = [\n\t// why\n\t"val_probe",\n];',
		groups: 'tables: ["users"]',
		types: 'export type DatabaseBackupTable = | "users";',
	});
	assert.equal(r1For("CREATE TABLE val_probe (id text);", files).status, "pass");
});

test("R1 warns when only a substring of another table name matches", () => {
	const r1 = r1For("CREATE TABLE tokens (id text);", listed("password_reset_tokens"));
	assert.equal(r1.status, "warn");
	assert.match(r1.details.join("\n"), /`tokens` is not listed/);
});

test("R1 ignores a table name that only appears in a comment", () => {
	const files = backupFiles({
		exportText: '// val_probe is coming\nconst BACKUP_TABLES = ["users"];\nconst INTERNAL_TABLES = ["d1_migrations"];',
		groups: 'tables: ["users"]',
		types: 'export type DatabaseBackupTable = | "users";',
	});
	assert.equal(r1For("CREATE TABLE val_probe (id text);", files).status, "warn");
});

test("R1 warns when a backed-up table is missing from groups or the type union", () => {
	const files = listed("val_probe");
	files[GROUPS] = 'tables: ["users"]';
	files[TYPES] = 'export type DatabaseBackupTable = | "users";';
	const text = r1For("CREATE TABLE val_probe (id text);", files).details.join("\n");
	assert.match(text, /BACKUP_TABLE_GROUPS/);
	assert.match(text, /DatabaseBackupTable/);
});

test("R1 warns for a drop without a change to backups/utils.ts", () => {
	const path = "drizzle/migrations/0100_x.sql";
	const readHead = (p) => (p === path ? "DROP TABLE old_t;" : null);
	const base = [
		{ status: "A", path },
		{ status: "M", path: "src/lib/backups/table-groups.ts" },
	];
	const warned = rule(checkRepoRules({ changes: base, readBase: noFiles, readHead }), "R1");
	assert.match(warned.details.join("\n"), /RETIRED_BACKUP_TABLES/);
	const fixed = [...base, { status: "M", path: "src/lib/backups/utils.ts" }];
	assert.equal(rule(checkRepoRules({ changes: fixed, readBase: noFiles, readHead }), "R1").status, "pass");
});

test("R2 warns for UI changes without e2e and clears with an e2e change", () => {
	const ui = { status: "A", path: "src/components/zz-probe.tsx" };
	const run = (changes) => rule(checkRepoRules({ changes, readBase: noFiles, readHead: noFiles }), "R2");
	assert.equal(run([ui]).status, "warn");
	assert.equal(run([ui, { status: "M", path: "e2e/01-auth.spec.ts" }]).status, "pass");
	assert.equal(run([{ status: "M", path: "src/app/api/foo/route.ts" }]).status, "pass");
	assert.equal(run([{ status: "M", path: "src/components/thing-types.d.ts" }]).status, "pass");
	assert.equal(run([{ status: "M", path: "src/app/(dashboard)/page.tsx" }]).status, "warn");
});

const wrangler = (queue, extra = "") => `{
	// comment
	"name": "mailflare",
	"queues": { "producers": [{ "binding": "OUTBOUND_QUEUE", "queue": "${queue}", },], },
	${extra}
}`;

test("R3 warns on a renamed queue and names old and new, but not on added bindings", () => {
	const read = (base, head) => ({
		readBase: (p) => (p === "wrangler.jsonc" ? base : null),
		readHead: (p) => (p === "wrangler.jsonc" ? head : null),
		changes: [],
	});
	const renamed = rule(checkRepoRules(read(wrangler("mailflare-outbound"), wrangler("kite-outbound"))), "R3");
	assert.equal(renamed.status, "warn");
	assert.match(renamed.details[0], /`mailflare-outbound` -> `kite-outbound`/);
	const added = wrangler(
		"mailflare-outbound",
		'"analytics_engine_datasets": [{ "binding": "METRICS", "dataset": "mailflare_metrics" }]',
	);
	assert.equal(rule(checkRepoRules(read(wrangler("mailflare-outbound"), added)), "R3").status, "pass");
	const removed = rule(checkRepoRules(read(wrangler("q"), '{ "name": "mailflare" }')), "R3");
	assert.match(removed.details[0], /removed/);
});

test("R3 warns when the Worker name changes in the relay config", () => {
	const file = "deploy/cloudflare-email-relay/wrangler.jsonc";
	const r3 = rule(
		checkRepoRules({
			changes: [],
			readBase: (p) => (p === file ? '{ "name": "mailflare-email-relay" }' : null),
			readHead: (p) => (p === file ? '{ "name": "relay2" }' : null),
		}),
		"R3",
	);
	assert.equal(r3.status, "warn");
	assert.match(r3.details[0], /mailflare-email-relay.*relay2/);
});

test("renderRepoRules prints warnings with details", () => {
	const text = renderRepoRules([{ id: "R2", title: "UI", status: "warn", details: ["x changed"] }]);
	assert.match(text, /\*\*R2\*\* UI: warning\n {2}- x changed/);
	assert.equal(renderRepoRules(null), "_not run_");
});

test("renderReport starts with the marker and truncates below the limit with a notice", () => {
	const sections = [{ title: "Security", body: "line\n".repeat(5000) }];
	const full = renderReport(sections, { maxChars: 100000 });
	assert.ok(full.startsWith(`${REPORT_MARKER}\n`));
	const cut = renderReport(sections, { maxChars: 2000 });
	assert.ok(cut.length <= 2000);
	assert.ok(cut.startsWith(REPORT_MARKER));
	assert.match(cut.trimEnd().split("\n").at(-1), /truncated/);
	assert.ok(renderReport(sections).length < 65536);
});

test("CLI prints 'not run' for missing inputs and appends to --summary-file", () => {
	const root = mkdtempSync(join(tmpdir(), "kite-pr-report-"));
	try {
		const script = new URL("../scripts/review/pr-report.mjs", import.meta.url).pathname;
		const summary = join(root, "summary.md");
		const run = () =>
			execFileSync("node", [script, "--base", "HEAD", "--inputs", join(root, "empty"), "--summary-file", summary], {
				encoding: "utf8",
				env: { ...process.env, GITHUB_TOKEN: "val-sentinel-token-123" },
			});
		const output = run();
		assert.ok(output.startsWith(`${REPORT_MARKER}\n`));
		for (const title of ["Security", "Quality", "Coverage"]) {
			const section = output.split(`## ${title}\n`)[1].split("\n## ")[0];
			assert.match(section, /_not run_/);
		}
		assert.doesNotMatch(output, /val-sentinel-token-123/);
		run();
		const written = readFileSync(summary, "utf8");
		assert.equal(written.split(REPORT_MARKER).length - 1, 2);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("CLI renders fixtures arranged like test-results", () => {
	const root = mkdtempSync(join(tmpdir(), "kite-pr-report-"));
	try {
		for (const [from, to] of [
			["semgrep.json", "review/semgrep.json"],
			["audit-head.json", "review/audit-head.json"],
			["audit-base.json", "review/audit-base.json"],
			["quality-summary.json", "quality/summary.json"],
			["todos.json", "quality/todos.json"],
			["coverage-summary.json", "coverage/summary.json"],
		]) {
			mkdirSync(join(root, to, ".."), { recursive: true });
			cpSync(join(fixtures, from), join(root, to));
		}
		const script = new URL("../scripts/review/pr-report.mjs", import.meta.url).pathname;
		const output = execFileSync("node", [script, "--base", "HEAD", "--inputs", root], { encoding: "utf8" });
		assert.match(output, /kite\.no-eval/);
		assert.match(output, /GHSA-aaaa-bbbb-cccc/);
		assert.match(output, /TODOs: 2 unlinked, 1 linked\./);
		assert.match(output, /weak-utils\.ts/);
		assert.doesNotMatch(output, /SNIPPET_SENTINEL|VIA_SENTINEL/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("failed Semgrep output never renders as clean", () => {
	for (const bad of [
		{ errors: [{ level: "error", type: "Fatal" }], results: [] },
		{ error: "boom" },
		[],
		"nope",
		{ results: "x" },
	]) {
		const outcome = semgrepOutcome(bad);
		assert.equal(outcome.failed, true);
		const text = renderSecurity({ semgrep: outcome, audit: null });
		assert.match(text, /Semgrep[\s\S]*failed/);
		assert.doesNotMatch(text, /No findings/);
	}
	assert.equal(semgrepOutcome({ results: [], errors: [{ level: "warn" }] }).failed, undefined);
	assert.match(renderSecurity({ semgrep: semgrepOutcome({ results: [] }), audit: null }), /No findings/);
});

test("failed npm audit output never renders as zero vulnerabilities", () => {
	const good = fixture("audit-head.json");
	for (const bad of [{ error: { code: "ENOLOCK", summary: "SECRET_DETAIL" } }, {}, [], "x", { vulnerabilities: {} }]) {
		const outcome = auditOutcome(bad, null);
		assert.equal(outcome.failed, true);
		const text = renderSecurity({ semgrep: null, audit: outcome });
		assert.match(text, /npm audit[\s\S]*failed/);
		assert.doesNotMatch(text, /0 critical|SECRET_DETAIL/);
	}
	const withBadBase = auditOutcome(good, { error: { code: "E" } });
	assert.equal(withBadBase.failed, undefined);
	assert.equal(withBadBase.baseMissing, true);
	assert.equal(withBadBase.newAdvisories.length, 2);
	assert.equal(auditOutcome(null, null), null);
});

test("duplication outcome renders pass, fail and not run", () => {
	const base = summarizeQuality({ newDebt: [] }, null);
	assert.match(renderQuality({ ...base, duplication: "pass" }), /Duplication check: pass/);
	assert.match(renderQuality({ ...base, duplication: "fail" }), /Duplication check: FAIL/);
	assert.match(renderQuality(base), /Duplication check: not run/);
	assert.equal(summarizeQuality({ newDebt: [] }, null, {}, { status: "fail" }).duplication, "fail");
	assert.equal(summarizeQuality({ newDebt: [] }, null, {}, { status: "pass" }).duplication, "pass");
	assert.equal(summarizeQuality({ newDebt: [] }, null, {}, { status: "weird" }).duplication, "not run");
	assert.equal(summarizeQuality({ newDebt: [] }, null, {}, null).duplication, "not run");
});

test("CLI reports failed scanners and a duplicate-only failure", () => {
	const root = mkdtempSync(join(tmpdir(), "kite-pr-report-"));
	try {
		mkdirSync(join(root, "review"), { recursive: true });
		mkdirSync(join(root, "quality"), { recursive: true });
		writeFileSync(join(root, "review/semgrep.json"), "not json");
		writeFileSync(join(root, "review/audit-head.json"), JSON.stringify({ error: { code: "E" } }));
		writeFileSync(join(root, "quality/summary.json"), JSON.stringify({ findings: {}, newDebt: [] }));
		writeFileSync(join(root, "quality/duplicates.json"), JSON.stringify({ status: "fail" }));
		const script = new URL("../scripts/review/pr-report.mjs", import.meta.url).pathname;
		const output = execFileSync("node", [script, "--base", "HEAD", "--inputs", root], { encoding: "utf8" });
		assert.doesNotMatch(output, /No findings|0 critical/);
		assert.match(output, /Semgrep[\s\S]*failed/);
		assert.match(output, /npm audit[\s\S]*failed/);
		assert.match(output, /No new debt/);
		assert.match(output, /Duplication check: FAIL/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("CLI renders the duplication outcome when the quality summary is missing", () => {
	const root = mkdtempSync(join(tmpdir(), "kite-pr-report-"));
	try {
		mkdirSync(join(root, "quality"), { recursive: true });
		writeFileSync(join(root, "quality/duplicates.json"), JSON.stringify({ status: "fail" }));
		const script = new URL("../scripts/review/pr-report.mjs", import.meta.url).pathname;
		const output = execFileSync("node", [script, "--base", "HEAD", "--inputs", root], { encoding: "utf8" });
		assert.match(output, /Duplication check: FAIL/);
		assert.doesNotMatch(output, /No new debt/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
