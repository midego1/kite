import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	DEFAULT_MAX_CHARS,
	auditOutcome,
	checkRepoRules,
	renderCoverage,
	renderQuality,
	renderReport,
	renderRepoRules,
	renderSecurity,
	semgrepOutcome,
	summarizeCoverage,
	summarizeQuality,
} from "./pr-report-utils.mjs";

const REF = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

export function parseArgs(argv) {
	const options = { base: "origin/main", inputs: "test-results", summaryFile: null, maxChars: DEFAULT_MAX_CHARS };
	const flags = { "--base": "base", "--inputs": "inputs", "--summary-file": "summaryFile", "--max-chars": "maxChars" };
	for (let index = 0; index < argv.length; index += 2) {
		const key = flags[argv[index]];
		if (!key || argv[index + 1] === undefined) throw new Error(`Unknown or incomplete option: ${argv[index]}`);
		options[key] = argv[index + 1];
	}
	options.maxChars = Number(options.maxChars);
	if (!Number.isInteger(options.maxChars) || options.maxChars < 500)
		throw new Error("--max-chars must be an integer of at least 500");
	if (!REF.test(options.base)) throw new Error("Invalid base revision");
	return options;
}

function readJson(path) {
	if (!existsSync(path)) return null;
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return null;
	}
}

// A scanner file that exists but is not JSON means the scan failed, which is not the same as not run.
function readScan(path) {
	if (!existsSync(path)) return null;
	return readJson(path) ?? "unreadable";
}

function git(args) {
	return execFileSync("git", args, {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "ignore"],
		maxBuffer: 64 * 1024 * 1024,
	});
}

function gitShow(rev, path) {
	try {
		return git(["show", `${rev}:${path}`]);
	} catch {
		return null;
	}
}

function parseNameStatus(output) {
	return output
		.split("\n")
		.filter(Boolean)
		.map((line) => {
			const [status, first, second] = line.split("\t");
			return { status, path: second ?? first, oldPath: second ? first : undefined };
		});
}

function loadChanges(base) {
	try {
		let mergeBase = base;
		try {
			mergeBase = git(["merge-base", base, "HEAD"]).trim();
		} catch {
			// Shallow or unrelated history: compare against the ref itself.
		}
		return { mergeBase, changes: parseNameStatus(git(["diff", "--name-status", "-M", mergeBase, "HEAD"])) };
	} catch {
		return null;
	}
}

export function buildReport(options) {
	const input = (name) => join(options.inputs, name);
	const loaded = loadChanges(options.base);
	const changedFiles = loaded?.changes.map((change) => change.path) ?? [];

	const semgrep = semgrepOutcome(readScan(input("review/semgrep.json")));
	const audit = auditOutcome(readScan(input("review/audit-head.json")), readScan(input("review/audit-base.json")));
	const security = renderSecurity({ semgrep, audit, changedFiles });

	const qualitySummary = readJson(input("quality/summary.json"));
	let baselineFindings = {};
	if (loaded) {
		try {
			baselineFindings = JSON.parse(gitShow(loaded.mergeBase, "scripts/quality/baseline.json") ?? "{}").findings ?? {};
		} catch {
			baselineFindings = {};
		}
	}
	const duplicates = readJson(input("quality/duplicates.json"));
	const quality =
		qualitySummary || duplicates
			? summarizeQuality(qualitySummary, readJson(input("quality/todos.json")), baselineFindings, duplicates)
			: null;

	const coverageSummary = readJson(input("coverage/summary.json"));
	const coverage = coverageSummary ? summarizeCoverage(coverageSummary) : null;

	const rules = loaded
		? checkRepoRules({
				changes: loaded.changes,
				readBase: (path) => gitShow(loaded.mergeBase, path),
				readHead: (path) => gitShow("HEAD", path),
			})
		: null;

	return renderReport(
		[
			{ title: "Security", body: security },
			{ title: "Quality", body: renderQuality(quality) },
			{ title: "Coverage", body: renderCoverage(coverage) },
			{ title: "Repo rules", body: renderRepoRules(rules) },
		],
		{ maxChars: options.maxChars },
	);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const options = parseArgs(process.argv.slice(2));
	const report = buildReport(options);
	process.stdout.write(report);
	if (options.summaryFile) appendFileSync(options.summaryFile, report);
}
