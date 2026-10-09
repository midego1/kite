import ts from "typescript";

export const REPORT_MARKER = "<!-- kite-pr-report -->";
export const DEFAULT_MAX_CHARS = 60000;
const NOT_RUN = "_not run_";
const SEVERITIES = ["critical", "high", "moderate", "low"];
const SEVERITY_RANK = { critical: 4, high: 3, moderate: 2, low: 1 };
const MAX_LISTED = 25;

// Only rule, severity, location and message are kept: `extra.lines` holds source snippets.
export function parseSemgrep(json) {
	const results = Array.isArray(json?.results) ? json.results : [];
	return results.map((result) => ({
		rule: String(result.check_id ?? "unknown"),
		severity: String(result.extra?.severity ?? "UNKNOWN"),
		file: String(result.path ?? ""),
		line: Number(result.start?.line ?? 0),
		message: String(result.extra?.message ?? "")
			.replace(/\s+/g, " ")
			.trim(),
	}));
}

const isObject = (value) => value != null && typeof value === "object" && !Array.isArray(value);

// A scan that errored still emits valid JSON, so shape and error levels decide whether it counts.
export function semgrepOutcome(json) {
	if (json == null) return null;
	if (!isObject(json) || !Array.isArray(json.results)) return { failed: true };
	const errors = Array.isArray(json.errors) ? json.errors : [];
	if (errors.some((error) => String(error?.level ?? "").toLowerCase() === "error")) return { failed: true };
	return parseSemgrep(json);
}

// npm audit v2 JSON: `via` objects are reduced to severity and URL, never kept whole.
function advisoriesOf(audit) {
	const found = new Map();
	for (const [name, vulnerability] of Object.entries(audit?.vulnerabilities ?? {})) {
		for (const via of vulnerability?.via ?? []) {
			if (!via || typeof via !== "object") continue;
			const url = typeof via.url === "string" ? via.url : "";
			found.set(`${name}|${url}`, { name, severity: String(via.severity ?? vulnerability.severity ?? "low"), url });
		}
	}
	return found;
}

export function summarizeAudit(head, base) {
	const counts = Object.fromEntries(SEVERITIES.map((severity) => [severity, 0]));
	for (const severity of SEVERITIES) counts[severity] = Number(head?.metadata?.vulnerabilities?.[severity] ?? 0);
	const baseKeys = advisoriesOf(base);
	const newAdvisories = [...advisoriesOf(head)]
		.filter(([key]) => !baseKeys.has(key))
		.map(([, advisory]) => advisory)
		.sort(
			(a, b) => (SEVERITY_RANK[b.severity] ?? 0) - (SEVERITY_RANK[a.severity] ?? 0) || a.name.localeCompare(b.name),
		);
	const fixable = Object.entries(head?.vulnerabilities ?? {})
		.filter(([, vulnerability]) => vulnerability?.fixAvailable)
		.map(([name]) => name)
		.sort();
	return { counts, newAdvisories, fixable };
}

// `summary.newDebt` is [key, value] pairs; the baseline findings come from the base revision.
export function summarizeQuality(summary, todos, baselineFindings = {}, duplicates = null) {
	const newDebt = (Array.isArray(summary?.newDebt) ? summary.newDebt : []).map(([key, value]) => ({
		key: String(key),
		value,
		baseline: baselineFindings[key] ?? 0,
	}));
	return {
		newDebt,
		summaryRun: summary != null,
		todosRun: todos != null,
		unlinkedTodos: Array.isArray(todos?.unlinked) ? todos.unlinked.length : 0,
		linkedTodos: Array.isArray(todos?.linked) ? todos.linked.length : 0,
		duplication: duplicates?.status === "pass" || duplicates?.status === "fail" ? duplicates.status : "not run",
	};
}

const validAudit = (audit) =>
	isObject(audit) &&
	!("error" in audit) &&
	isObject(audit.vulnerabilities) &&
	isObject(audit.metadata?.vulnerabilities);

export function auditOutcome(head, base) {
	if (head == null) return null;
	if (!validAudit(head)) return { failed: true };
	return { ...summarizeAudit(head, validAudit(base) ? base : null), baseMissing: !validAudit(base) };
}

export function summarizeCoverage(summary) {
	const files = (Array.isArray(summary?.files) ? summary.files : []).map((file) => ({
		file: String(file.file),
		lines: file.lines,
		branches: file.branches,
		functions: file.functions,
		threshold: file.thresholds ?? {},
		pass: file.passed !== false,
	}));
	return { aggregate: summary?.aggregate ?? null, files };
}

const TABLE_NAME = "[\"'`\\[]?(\\w+)[\"'`\\]]?";

export function parseMigrationTableChanges(sql) {
	const text = String(sql).replace(/--[^\n]*/g, "");
	const names = (re) => [...text.matchAll(re)].map((match) => match[1]);
	const created = names(new RegExp(`CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${TABLE_NAME}`, "gi"));
	const dropped = names(new RegExp(`DROP\\s+TABLE\\s+(?:IF\\s+EXISTS\\s+)?${TABLE_NAME}`, "gi"));
	const renamed = [
		...text.matchAll(new RegExp(`ALTER\\s+TABLE\\s+${TABLE_NAME}\\s+RENAME\\s+TO\\s+${TABLE_NAME}`, "gi")),
	].map((match) => ({
		from: match[1],
		to: match[2],
	}));
	// Drizzle rebuilds a table as __new_<t> created, <t> dropped, __new_<t> renamed to <t>: net zero.
	const remove = (list, name) => {
		const index = list.indexOf(name);
		if (index >= 0) list.splice(index, 1);
	};
	const netRenamed = [];
	for (const rename of renamed) {
		if (rename.from === `__new_${rename.to}` && created.includes(rename.from)) {
			remove(created, rename.from);
			remove(dropped, rename.to);
		} else netRenamed.push(rename);
	}
	return { created, dropped, renamed: netRenamed };
}

const BACKUP_FILES = ["src/lib/backups/export.ts", "src/lib/backups/table-groups.ts", "src/lib/backups/types.d.ts"];
const BACKUP_UTILS = "src/lib/backups/utils.ts";

const stripComments = (text) =>
	String(text ?? "")
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.replace(/\/\/[^\n]*/g, "");
const quoted = (text) => [...text.matchAll(/["'`]([^"'`\n]+)["'`]/g)].map((match) => match[1]);

// Exact string entries of `const NAME ... = [ ... ]`, so a name embedded in another one or in a comment never counts.
function stringsIn(source, name) {
	const text = stripComments(source);
	for (const match of text.matchAll(new RegExp(`\\b${name}\\b[^=\\n]*=\\s*\\[([\\s\\S]*?)\\]`, "g"))) {
		return new Set(quoted(match[1]));
	}
	return new Set();
}

function groupTables(source) {
	const text = stripComments(source);
	const names = [...text.matchAll(/\btables\s*:\s*\[([\s\S]*?)\]/g)].flatMap((match) => quoted(match[1]));
	return new Set(names);
}

function typeMembers(source) {
	const match = /\btype\s+DatabaseBackupTable\s*=([^;]*);/.exec(stripComments(source));
	return new Set(match ? quoted(match[1]) : []);
}

function checkBackupLists({ changes, readHead }) {
	const touched = new Set(changes.map((change) => change.path));
	const details = [];
	const created = new Set();
	const dropped = new Set();
	const renamed = [];
	for (const change of changes) {
		if (!/^drizzle\/migrations\/[^/]+\.sql$/.test(change.path) || !/^[AMR]/.test(change.status)) continue;
		const sql = readHead(change.path);
		if (sql == null) continue;
		const result = parseMigrationTableChanges(sql);
		result.created.forEach((name) => created.add(name));
		result.dropped.forEach((name) => dropped.add(name));
		renamed.push(...result.renamed);
	}
	const changedTables = [...created, ...dropped, ...renamed.flatMap((rename) => [rename.from, rename.to])];
	if (changedTables.length && !BACKUP_FILES.some((file) => touched.has(file))) {
		details.push(
			`Tables changed by migrations (${[...new Set(changedTables)].join(", ")}) but none of ${BACKUP_FILES.join(", ")} changed. See AGENTS.md "Database backup and restore".`,
		);
	}
	const lists = {
		backup: stringsIn(readHead(BACKUP_FILES[0]), "BACKUP_TABLES"),
		internal: stringsIn(readHead(BACKUP_FILES[0]), "INTERNAL_TABLES"),
		groups: groupTables(readHead(BACKUP_FILES[1])),
		types: typeMembers(readHead(BACKUP_FILES[2])),
	};
	for (const name of created) {
		if (lists.internal.has(name)) continue;
		if (!lists.backup.has(name)) {
			details.push(`Created table \`${name}\` is not listed in ${BACKUP_FILES[0]} (BACKUP_TABLES or INTERNAL_TABLES).`);
			continue;
		}
		if (!lists.groups.has(name))
			details.push(`Created table \`${name}\` is not in BACKUP_TABLE_GROUPS (${BACKUP_FILES[1]}).`);
		if (!lists.types.has(name))
			details.push(`Created table \`${name}\` is not in DatabaseBackupTable (${BACKUP_FILES[2]}).`);
	}
	if ((dropped.size || renamed.length) && !touched.has(BACKUP_UTILS)) {
		const names = [...dropped, ...renamed.map((rename) => rename.from)];
		details.push(
			`Dropped or renamed table(s) ${[...new Set(names)].join(", ")}: check RETIRED_BACKUP_TABLES in ${BACKUP_UTILS}.`,
		);
	}
	return { id: "R1", title: "Backup lists follow table changes", status: details.length ? "warn" : "pass", details };
}

function checkUiWithoutE2e({ changes }) {
	const ui = changes.filter(
		(change) =>
			/^(src\/app\/|src\/components\/)/.test(change.path) &&
			!change.path.startsWith("src/app/api/") &&
			/\.(tsx|ts|css|scss)$/.test(change.path) &&
			!/-types\.d\.ts$/.test(change.path),
	);
	const e2e = changes.some((change) => change.path.startsWith("e2e/"));
	const details =
		ui.length && !e2e
			? [`UI files changed without an e2e change: ${ui.map((change) => `\`${change.path}\``).join(", ")}.`]
			: [];
	return { id: "R2", title: "UI changes come with e2e coverage", status: details.length ? "warn" : "pass", details };
}

const WRANGLER_FILES = ["wrangler.jsonc", "deploy/cloudflare-email-relay/wrangler.jsonc"];

function parseJsonc(text) {
	if (text == null) return null;
	const { config, error } = ts.parseConfigFileTextToJson("wrangler.jsonc", text);
	return error ? null : config;
}

function entryKey(item, index) {
	return String(item?.binding ?? item?.name ?? item?.class_name ?? item?.queue ?? item?.tag ?? index);
}

export function extractResourceNames(config) {
	const names = new Map();
	if (!config || typeof config !== "object") return names;
	const put = (label, value) => {
		if (typeof value === "string") names.set(label, value);
	};
	const each = (list, label, fields) => {
		(Array.isArray(list) ? list : []).forEach((item, index) => {
			for (const field of fields) put(`${label}[${entryKey(item, index)}].${field}`, item?.[field]);
		});
	};
	put("name", config.name);
	each(config.services, "services", ["service"]);
	each(config.d1_databases, "d1_databases", ["database_name", "database_id"]);
	each(config.r2_buckets, "r2_buckets", ["bucket_name", "preview_bucket_name"]);
	each(config.queues?.producers, "queues.producers", ["queue"]);
	each(config.queues?.consumers, "queues.consumers", ["queue"]);
	each(config.durable_objects?.bindings, "durable_objects.bindings", ["class_name"]);
	each(config.migrations, "migrations", ["tag"]);
	each(config.analytics_engine_datasets, "analytics_engine_datasets", ["dataset"]);
	return names;
}

function checkCloudflareNames({ readBase, readHead }) {
	const details = [];
	for (const file of WRANGLER_FILES) {
		const before = extractResourceNames(parseJsonc(readBase(file)));
		const after = extractResourceNames(parseJsonc(readHead(file)));
		for (const [label, oldValue] of before) {
			const newValue = after.get(label);
			if (newValue !== oldValue)
				details.push(`${file} ${label}: \`${oldValue}\` -> ${newValue === undefined ? "removed" : `\`${newValue}\``}`);
		}
	}
	return {
		id: "R3",
		title: "Cloudflare resource names are unchanged",
		status: details.length ? "warn" : "pass",
		details,
	};
}

export function checkRepoRules({ changes, readBase, readHead }) {
	const input = { changes, readBase, readHead };
	return [checkBackupLists(input), checkUiWithoutE2e(input), checkCloudflareNames(input)];
}

const cell = (value) => String(value ?? "").replace(/\|/g, "\\|");

export function renderSecurity({ semgrep, audit, changedFiles = [] }) {
	const lines = ["### Semgrep", ""];
	if (!semgrep) lines.push(NOT_RUN);
	else if (semgrep.failed) lines.push("Scan failed or its output was unreadable, so there is no result.");
	else if (!semgrep.length) lines.push("No findings.");
	else {
		const changed = new Set(changedFiles);
		lines.push(`${semgrep.length} finding(s).`, "");
		for (const finding of semgrep.slice(0, MAX_LISTED)) {
			const mark = changed.has(finding.file) ? " **(changed in this PR)**" : "";
			lines.push(
				`- \`${finding.file}:${finding.line}\` ${finding.severity} \`${finding.rule}\`: ${finding.message}${mark}`,
			);
		}
		if (semgrep.length > MAX_LISTED) lines.push(`- ... and ${semgrep.length - MAX_LISTED} more`);
	}
	lines.push("", "### npm audit (production dependencies)", "");
	if (!audit) lines.push(NOT_RUN);
	else if (audit.failed) lines.push("Audit failed or its output was unreadable, so there is no result.");
	else {
		lines.push(`Head: ${SEVERITIES.map((severity) => `${audit.counts[severity]} ${severity}`).join(", ")}.`);
		if (audit.baseMissing) lines.push("Base audit not run or failed, so every advisory counts as new.");
		if (!audit.newAdvisories.length) lines.push("", "No new advisories compared with the base.");
		else {
			lines.push("", "New compared with the base:", "");
			for (const advisory of audit.newAdvisories.slice(0, MAX_LISTED)) {
				lines.push(`- \`${advisory.name}\` ${advisory.severity}${advisory.url ? ` ${advisory.url}` : ""}`);
			}
		}
	}
	return lines.join("\n");
}

export function renderQuality(quality) {
	if (!quality) return NOT_RUN;
	const lines = [];
	if (quality.summaryRun === false) lines.push("Quality summary: not run");
	else if (!quality.newDebt.length) lines.push("No new debt compared with the baseline.");
	else {
		lines.push(`${quality.newDebt.length} new debt key(s):`, "", "| Key | Value | Baseline |", "| --- | --- | --- |");
		for (const entry of quality.newDebt.slice(0, MAX_LISTED))
			lines.push(`| \`${cell(entry.key)}\` | ${cell(entry.value ?? "-")} | ${cell(entry.baseline ?? "-")} |`);
		if (quality.newDebt.length > MAX_LISTED) lines.push("", `... and ${quality.newDebt.length - MAX_LISTED} more`);
	}
	lines.push(
		"",
		quality.todosRun === false
			? "TODOs: not run"
			: `TODOs: ${quality.unlinkedTodos} unlinked, ${quality.linkedTodos} linked.`,
		`Duplication check: ${quality.duplication === "fail" ? "FAIL" : (quality.duplication ?? "not run")}`,
	);
	return lines.join("\n");
}

const pct = (value) => (typeof value === "number" ? `${value}%` : "-");

export function renderCoverage(coverage) {
	if (!coverage) return NOT_RUN;
	const lines = [];
	if (coverage.aggregate) {
		lines.push(
			`Aggregate: lines ${pct(coverage.aggregate.lines)}, branches ${pct(coverage.aggregate.branches)}, functions ${pct(coverage.aggregate.functions)}.`,
		);
	}
	if (coverage.files.length) {
		lines.push(
			"",
			"| Gated file | Lines | Branches | Functions | Thresholds | Result |",
			"| --- | --- | --- | --- | --- | --- |",
		);
		for (const file of coverage.files) {
			const thresholds = Object.entries(file.threshold)
				.map(([metric, value]) => `${metric} ${value}`)
				.join(", ");
			lines.push(
				`| \`${cell(file.file)}\` | ${pct(file.lines)} | ${pct(file.branches)} | ${pct(file.functions)} | ${cell(thresholds)} | ${file.pass ? "pass" : "FAIL"} |`,
			);
		}
	}
	return lines.join("\n");
}

export function renderRepoRules(rules) {
	if (!rules) return NOT_RUN;
	const lines = [];
	for (const rule of rules) {
		lines.push(`- **${rule.id}** ${rule.title}: ${rule.status === "pass" ? "pass" : "warning"}`);
		for (const detail of rule.details) lines.push(`  - ${detail}`);
	}
	return lines.join("\n");
}

export function renderReport(sections, { maxChars = DEFAULT_MAX_CHARS } = {}) {
	const body = [REPORT_MARKER, "## Kite PR report", "", "_Advisory only: this report never blocks a merge._"];
	for (const section of sections) body.push("", `## ${section.title}`, "", section.body);
	const text = `${body.join("\n")}\n`;
	if (text.length <= maxChars) return text;
	const notice = `\n\n_Report truncated at ${maxChars} characters. See the workflow step summary for the full report._\n`;
	return text.slice(0, Math.max(REPORT_MARKER.length, maxChars - notice.length)) + notice;
}
