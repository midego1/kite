import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { builtinModules } from "node:module";
import { ESLint } from "eslint";
import prettier from "prettier";
import ts from "typescript";
import { findTodoMarkers, isScannedFile } from "./todo-utils.mjs";
import { packageVersion } from "../version-utils.mjs";

const update = process.argv.includes("--update-baseline");
// --staged checks the index copy of staged files only, for the pre-commit hook.
const stagedOnly = process.argv.includes("--staged");
const formatOnly = process.argv.includes("format") || stagedOnly;
const baselinePath = "scripts/quality/baseline.json";
const reportDir = "test-results/quality";
await fs.mkdir(reportDir, { recursive: true });
const listed = stagedOnly
	? spawnSync("git", ["diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z"], { encoding: "utf8" })
	: spawnSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { encoding: "utf8" });
if (listed.status !== 0) throw new Error(listed.stderr);
const files = [...new Set(listed.stdout.split("\0").filter(Boolean))].sort();
const findings = {};
const add = (key, value = 1) => {
	findings[key] = (findings[key] || 0) + value;
};
/** @param {string} file */
async function readForFormat(file) {
	if (!stagedOnly) return existsSync(file) ? fs.readFile(file, "utf8") : null;
	const staged = spawnSync("git", ["show", `:${file}`], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
	if (staged.status !== 0) throw new Error(staged.stderr);
	return staged.stdout;
}
// Formatting has no baseline: every file Prettier does not ignore must be formatted.
const unformatted = [];
for (const file of files) {
	const info = await prettier.getFileInfo(file, { ignorePath: ".prettierignore" });
	if (info.ignored || !info.inferredParser) continue;
	const contents = await readForFormat(file);
	if (contents === null) continue;
	if (!(await prettier.check(contents, { ...(await prettier.resolveConfig(file)), filepath: file })))
		unformatted.push(file);
}
if (unformatted.length) {
	console.error(
		`${unformatted.length} file(s) are not formatted with Prettier. Run \`npx prettier --write <file>\` (or \`npm run format\`):`,
	);
	for (const file of unformatted) console.error(`  ${file}`);
	process.exitCode = 1;
	if (update) throw new Error("Format the files above before recording a quality baseline");
} else console.log(`Formatting: ${stagedOnly ? "staged" : "all"} files pass Prettier.`);
if (!formatOnly) {
	const eslint = new ESLint({
		overrideConfig: [
			{
				rules: {
					complexity: ["warn", 20],
					"max-lines": ["warn", { max: 500, skipBlankLines: true, skipComments: true }],
				},
			},
		],
	});
	const results = await eslint.lintFiles([
		"src",
		"server",
		"worker.ts",
		"worker-utils.ts",
		"deploy/cloudflare-email-relay/src",
	]);
	await fs.writeFile(`${reportDir}/lint.json`, JSON.stringify(results, null, 2));
	const lintFindings = new Map();
	for (const result of results)
		for (const message of result.messages) {
			if (!["complexity", "max-lines", "@typescript-eslint/no-unused-vars"].includes(message.ruleId)) continue;
			const file = path.relative(process.cwd(), result.filePath);
			const metric =
				message.ruleId === "complexity"
					? Number(message.message.match(/complexity of (\d+)/)?.[1])
					: message.ruleId === "max-lines"
						? Number(message.message.match(/\((\d+)\)/)?.[1])
						: 1;
			const stable = message.message.replace(/complexity of \d+/, "complexity").replace(/\(\d+\)/, "(lines)");
			const key = `lint:${file}:${message.ruleId}:${stable}`;
			const values = lintFindings.get(key) || [];
			values.push(metric || 1);
			lintFindings.set(key, values);
		}
	for (const [key, values] of lintFindings) {
		values.sort((a, b) => b - a).forEach((value, index) => add(`${key}:occurrence=${index + 1}`, value));
	}
	const knip = spawnSync(process.execPath, ["scripts/quality/knip.mjs", "--reporter", "json", "--no-progress"], {
		encoding: "utf8",
		maxBuffer: 32 * 1024 * 1024,
	});
	if (![0, 1].includes(knip.status)) throw new Error(`Knip failed: ${knip.stderr}`);
	let dead;
	try {
		dead = JSON.parse(knip.stdout);
	} catch {
		throw new Error(`Knip did not return valid findings: ${knip.stderr}\n${knip.stdout}`);
	}
	await fs.writeFile(`${reportDir}/dead-code.json`, JSON.stringify(dead, null, 2));
	for (const file of dead.files || []) add(`knip:files:${file}`);
	for (const issue of dead.issues || [])
		for (const [kind, values] of Object.entries(issue)) {
			if (
				![
					"files",
					"dependencies",
					"devDependencies",
					"unlisted",
					"unresolved",
					"exports",
					"types",
					"enumMembers",
					"namespaceMembers",
					"duplicates",
					"binaries",
					"catalog",
					"catalogReferences",
				].includes(kind) ||
				!Array.isArray(values)
			)
				continue;
			for (const value of values)
				add(
					`knip:${issue.file}:${kind}:${typeof value === "string" ? value : value.name || value.symbol || JSON.stringify(value)}`,
				);
		}
	const sources = new Map();
	for (const file of files.filter(
		(f) => /\.[cm]?[jt]sx?$/.test(f) && /^(src\/|server\/|worker|deploy\/cloudflare-email-relay\/src\/)/.test(f),
	)) {
		sources.set(file, ts.createSourceFile(file, await fs.readFile(file, "utf8"), ts.ScriptTarget.Latest, true));
	}
	const resolve = (from, specifier) => {
		const base = specifier.startsWith("@/")
			? `src/${specifier.slice(2)}`
			: specifier.startsWith(".")
				? path.posix.normalize(path.posix.join(path.posix.dirname(from), specifier))
				: null;
		if (!base) return null;
		return [base, ...[".ts", ".tsx", ".js", ".mjs", "/index.ts", "/index.tsx"].map((ext) => base + ext)].find(
			(candidate) => sources.has(candidate),
		);
	};
	const edges = new Map();
	for (const [file, source] of sources) {
		const imports = [];
		const visit = (node) => {
			const typeOnlyBindings =
				ts.isImportDeclaration(node) &&
				!node.importClause?.name &&
				node.importClause?.namedBindings &&
				ts.isNamedImports(node.importClause.namedBindings) &&
				node.importClause.namedBindings.elements.every((element) => element.isTypeOnly);
			if (
				(ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
				node.moduleSpecifier &&
				!node.isTypeOnly &&
				!node.importClause?.isTypeOnly &&
				!typeOnlyBindings
			)
				imports.push(node.moduleSpecifier.text);
			if (
				ts.isCallExpression(node) &&
				node.arguments[0] &&
				ts.isStringLiteral(node.arguments[0]) &&
				(node.expression.kind === ts.SyntaxKind.ImportKeyword || node.expression.getText(source) === "require")
			)
				imports.push(node.arguments[0].text);
			ts.forEachChild(node, visit);
		};
		visit(source);
		edges.set(file, imports);
		if (file.startsWith("deploy/cloudflare-email-relay/src/"))
			for (const spec of imports) {
				const dest = resolve(file, spec);
				// Portable shared observability helpers intentionally serve both deployments.
				if (
					dest &&
					!dest.startsWith("deploy/cloudflare-email-relay/") &&
					!["src/lib/logger.mjs", "src/lib/trace.mjs", "src/lib/metrics.mjs"].includes(dest)
				)
					add(`boundary:relay:${file}->${dest}`);
			}
	}
	for (const [file, source] of sources) {
		if (
			!source.statements.some(
				(node) =>
					ts.isExpressionStatement(node) &&
					ts.isStringLiteral(node.expression) &&
					node.expression.text === "use client",
			)
		)
			continue;
		const seen = new Set();
		const walk = (current) => {
			if (seen.has(current)) return;
			seen.add(current);
			// Next server actions are intentional RPC boundaries, not browser module imports.
			if (
				sources
					.get(current)
					?.statements.some(
						(node) =>
							ts.isExpressionStatement(node) &&
							ts.isStringLiteral(node.expression) &&
							node.expression.text === "use server",
					)
			)
				return;
			for (const spec of edges.get(current) || []) {
				const dest = resolve(current, spec);
				if (
					builtinModules.includes(spec) ||
					/^(node:|cloudflare:|server-only$|better-sqlite3$|smtp-server$|nodemailer$)/.test(spec) ||
					(dest && /^(src\/db\/|server\/|worker\.|deploy\/)/.test(dest))
				)
					add(`boundary:client:${file}:${current}->${dest || spec}`);
				else if (dest) walk(dest);
			}
		};
		walk(file);
	}
	const root = JSON.parse(await fs.readFile("package.json"));
	const relay = JSON.parse(await fs.readFile("deploy/cloudflare-email-relay/package.json"));
	const version = (await fs.readFile("VERSION", "utf8")).trim();
	if (packageVersion(version) !== root.version)
		throw new Error(`package.json ${root.version} must be ${packageVersion(version)} for VERSION ${version}`);
	const allDeps = (pkg) => ({ ...pkg.dependencies, ...pkg.devDependencies });
	for (const [name, range] of Object.entries(allDeps(relay)))
		if (allDeps(root)[name] && range !== allDeps(root)[name])
			add(`drift:${name}:root=${allDeps(root)[name]}:relay=${range}`);
	// Unlike the debt above, task markers have no baseline: every one needs an issue link.
	const markers = [];
	for (const file of files) {
		if (!isScannedFile(file) || !existsSync(file)) continue;
		const contents = await fs.readFile(file, "utf8");
		if (isScannedFile(file, contents)) markers.push(...findTodoMarkers(contents, file));
	}
	const linked = markers.filter((marker) => marker.issue !== null);
	const unlinked = markers.filter((marker) => marker.issue === null);
	await fs.writeFile(`${reportDir}/todos.json`, JSON.stringify({ linked, unlinked }, null, 2));
	console.log(`Task marker policy: ${linked.length} linked marker(s), ${unlinked.length} unlinked.`);
	if (unlinked.length) {
		console.error(
			"Unlinked task markers need an issue reference, for example `(#123)` right after the word (docs/quality.md):",
		);
		for (const marker of unlinked) console.error(`  ${marker.file}:${marker.line} ${marker.marker}`);
		process.exitCode = 1;
	}
}
let baseline = {};
if (formatOnly) {
	if (update) throw new Error("Use full quality:baseline to update all debt together");
	await fs.writeFile(`${reportDir}/format.json`, JSON.stringify({ unformatted }, null, 2));
} else if (update) {
	await fs.writeFile(baselinePath, JSON.stringify({ generatedAt: new Date().toISOString(), findings }, null, 2) + "\n");
	console.log(
		`Recorded ${Object.keys(findings).length} existing findings; inspect the baseline diff before accepting it.`,
	);
} else {
	baseline = JSON.parse(await fs.readFile(baselinePath, "utf8")).findings;
	const newDebt = Object.entries(findings).filter(([key, value]) => value > (baseline[key] || 0));
	await fs.writeFile(
		`${reportDir}/summary.json`,
		JSON.stringify({ findings, newDebt, existingDebt: Object.keys(findings).length - newDebt.length }, null, 2),
	);
	console.log(
		`${Object.keys(findings).length} current findings; ${newDebt.length} new or increased findings. Full results: ${reportDir}`,
	);
	for (const [key, value] of newDebt) console.error(`${key} (${value}, baseline ${baseline[key] || 0})`);
	if (newDebt.length) process.exitCode = 1;
}
if (!formatOnly) {
	const args = [
		"--config",
		".jscpd.json",
		"--baseline",
		"scripts/quality/duplicates-baseline.json",
		"--fail-on-empty",
		...(update ? ["--update-baseline"] : ["--fail-on-new-clones"]),
	];
	const duplicates = spawnSync("node_modules/.bin/jscpd", args, { stdio: "inherit" });
	if (duplicates.status !== 0) process.exitCode = 1;
}
