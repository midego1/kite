import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { gzipSync } from "node:zlib";
import {
	ALLOWANCE_DIRECTORY,
	addedAllowanceFiles,
	checkBundles,
	describeBundles,
	effectiveBudgets,
	parseAllowance,
	resolveBundleBase,
} from "./bundle-budget-utils.mjs";

const directory = "test-results/quality";
await fs.mkdir(directory, { recursive: true });
async function sizes(root) {
	const files = [];
	async function walk(dir) {
		for (const item of await fs.readdir(dir, { withFileTypes: true })) {
			const file = path.join(dir, item.name);
			if (item.isDirectory()) await walk(file);
			else if (/\.[cm]?js$/.test(file)) {
				const data = await fs.readFile(file);
				files.push({ file, bytes: data.length, gzipBytes: gzipSync(data).length });
			}
		}
	}
	await walk(root);
	if (!files.length) throw new Error(`No JavaScript build output in ${root}; run npm run build first`);
	return {
		files: files.length,
		bytes: files.reduce((total, item) => total + item.bytes, 0),
		gzipBytes: files.reduce((total, item) => total + item.gzipBytes, 0),
		largest: files.sort((a, b) => b.bytes - a.bytes).slice(0, 15),
	};
}
async function measure(root) {
	return { client: await sizes(path.join(root, "dist/client")), worker: await sizes(path.join(root, "dist/server")) };
}

const git = (...args) =>
	execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 1 << 28 }).trimEnd();
const flag = process.argv.indexOf("--base");
const requested = (flag > 0 ? process.argv[flag + 1] : process.env.BUNDLE_BASE) || "";

const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const showAt = (sha, file) => git("show", `${sha}:${file}`);

/**
 * Builds `sha` in a scratch copy under test-results and measures it; cached per commit and lockfile. The
 * checkout's node_modules are linked in unless package-lock.json differs between the base and this change:
 * then the base installs its own dependencies (`npm ci`; the base is trusted code), so growth that comes
 * from a dependency shows up in the comparison and a lockfile change cannot break the base build.
 */
async function baseSizes(sha) {
	const baseLock = showAt(sha, "package-lock.json"); // trimmed, like the checkout's text below
	const ownDependencies = sha256(baseLock) !== sha256((await fs.readFile("package-lock.json", "utf8")).trimEnd());
	const key = `base-${sha.slice(0, 12)}-${sha256(baseLock).slice(0, 12)}`;
	const cache = path.join(directory, `${key}.json`);
	try {
		return JSON.parse(await fs.readFile(cache, "utf8"));
	} catch {
		// Not measured yet.
	}
	const root = path.resolve(directory, key);
	await fs.rm(root, { recursive: true, force: true });
	await fs.mkdir(root, { recursive: true });
	const npm = process.platform === "win32" ? "npm.cmd" : "npm";
	const run = (args, what) => {
		const result = spawnSync(npm, args, { cwd: root, encoding: "utf8", maxBuffer: 1 << 28 });
		if (result.status !== 0) {
			console.error(String(result.stderr).slice(-4000));
			throw new Error(what);
		}
	};
	try {
		const archive = spawnSync("git", ["archive", sha], { maxBuffer: 1 << 30 });
		if (archive.status !== 0) throw new Error(`git archive ${sha} failed`);
		const extract = spawnSync("tar", ["-x", "-C", root], { input: archive.stdout });
		if (extract.status !== 0) throw new Error("could not unpack the base commit");
		if (ownDependencies) {
			console.log("package-lock.json changed; installing the base's own dependencies...");
			run(["ci", "--ignore-scripts=false", "--no-audit", "--no-fund"], "npm ci failed for the base commit");
		} else await fs.symlink(path.resolve("node_modules"), path.join(root, "node_modules"), "dir");
		console.log(`Building base ${sha.slice(0, 12)} to measure this change's growth...`);
		run(["run", "build"], "the base commit did not build");
		const measured = await measure(root);
		for (const kind of ["client", "worker"]) delete measured[kind].largest;
		await fs.writeFile(cache, JSON.stringify(measured, null, 2));
		return measured;
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
}

/** The growth allowance files this change adds (those not already in the base), parsed. */
async function addedAllowances(sha) {
	let inBase;
	try {
		inBase = new Set(git("ls-tree", "-r", "--name-only", sha, "--", ALLOWANCE_DIRECTORY).split("\n"));
	} catch {
		inBase = new Set();
	}
	let names = [];
	try {
		names = await fs.readdir(ALLOWANCE_DIRECTORY);
	} catch {
		// No allowance directory: nothing added.
	}
	const added = addedAllowanceFiles(names, inBase);
	const allowances = [];
	const problems = [...added.problems];
	for (const relative of added.files) {
		const parsed = parseAllowance(await fs.readFile(relative, "utf8"), relative);
		problems.push(...parsed.problems);
		if (parsed.allowance) allowances.push(parsed.allowance);
	}
	return { allowances, problems };
}

const results = await measure(".");
const headBudgets = JSON.parse(await fs.readFile("scripts/quality/bundle-budgets.json"));
const problems = [];
const onPullRequest = process.env.GITHUB_EVENT_NAME === "pull_request";

let base = null;
let allowances = [];
let budgets = headBudgets;
const target = resolveBundleBase({ requested, env: process.env, git });
// Without a comparison only the ceiling applies. On a pull request that is a failure (a silent skip would
// let any change through); elsewhere it is a warning, except where no comparison is wanted at all.
function unavailable(reason) {
	if (onPullRequest) problems.push(`Bundle growth could not be compared with the base: ${reason}.`);
	else console.warn(`::warning::Bundle growth was not compared with the base: ${reason}. Only the ceiling applies.`);
}
if (target.sha) {
	try {
		base = await baseSizes(target.sha);
		let baseFile = null;
		try {
			baseFile = JSON.parse(showAt(target.sha, "scripts/quality/bundle-budgets.json"));
		} catch {
			// The base has no budgets file: the checkout's apply.
		}
		budgets = effectiveBudgets(headBudgets, baseFile);
		const added = await addedAllowances(target.sha);
		allowances = added.allowances;
		problems.push(...added.problems);
	} catch (error) {
		unavailable(error.message);
	}
} else if (target.expected)
	console.log(`Bundle growth is not compared with a base (${target.reason}); only the ceiling applies.`);
else unavailable(target.reason);

const checked = checkBundles({ results, budgets, base, allowances });
problems.push(...checked.problems);
for (const line of describeBundles(results, checked.growth, checked.limits)) console.log(line);
if (allowances.length) console.log(`Growth allowances in this change: ${allowances.length}.`);
for (const problem of problems) console.error(problem);
await fs.writeFile(
	`${directory}/bundle.json`,
	JSON.stringify(
		{
			generatedAt: new Date().toISOString(),
			...results,
			base: base && { sha: target.sha, client: base.client, worker: base.worker },
			growth: checked.growth,
			limits: checked.limits,
		},
		null,
		2,
	),
);
if (problems.length) process.exitCode = 1;
