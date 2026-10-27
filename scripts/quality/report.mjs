import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { resolveBase } from "../release-check-utils.mjs";
import {
	ALLOWANCE_DIRECTORY,
	checkBundles,
	describeBundles,
	isAllowanceFile,
	parseAllowance,
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

const git = (...args) => execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trimEnd();
const flag = process.argv.indexOf("--base");
const requested = (flag > 0 ? process.argv[flag + 1] : process.env.BUNDLE_BASE) || "";

/**
 * The commit this build is compared with: BUNDLE_BASE (or --base) when given, `none` to skip the comparison;
 * on a pull request the first parent of GitHub's merge commit (the base it was merged onto); locally the
 * merge-base with origin/main. A push to main has no base: only the ceiling applies. Returns null with a
 * reason when none can be found.
 */
function baseCommit() {
	if (requested === "none") return { reason: "BUNDLE_BASE=none" };
	try {
		if (requested) return { sha: git("rev-parse", "--verify", `${requested}^{commit}`) };
		if (process.env.GITHUB_EVENT_NAME === "pull_request") {
			const sha = resolveBase(git, `origin/${process.env.GITHUB_BASE_REF || "main"}`, { pullRequest: true });
			return { sha: git("rev-parse", "--verify", `${sha}^{commit}`) };
		}
		if (process.env.GITHUB_EVENT_NAME) return { reason: `a ${process.env.GITHUB_EVENT_NAME} has no base` };
		return { sha: git("merge-base", "HEAD", "origin/main") };
	} catch {
		return { reason: "the base commit is not available (fetch it, or pass --base <ref>)" };
	}
}

/** Builds `sha` in a scratch copy under test-results, reusing the repository's node_modules; cached per commit. */
async function baseSizes(sha) {
	const cache = path.join(directory, `base-${sha.slice(0, 12)}.json`);
	try {
		return JSON.parse(await fs.readFile(cache, "utf8"));
	} catch {
		// Not measured yet.
	}
	const root = path.resolve(directory, `base-${sha.slice(0, 12)}`);
	await fs.rm(root, { recursive: true, force: true });
	await fs.mkdir(root, { recursive: true });
	try {
		const archive = spawnSync("git", ["archive", sha], { maxBuffer: 1 << 30 });
		if (archive.status !== 0) throw new Error(`git archive ${sha} failed`);
		const extract = spawnSync("tar", ["-x", "-C", root], { input: archive.stdout });
		if (extract.status !== 0) throw new Error("could not unpack the base commit");
		await fs.symlink(path.resolve("node_modules"), path.join(root, "node_modules"), "dir");
		console.log(`Building base ${sha.slice(0, 12)} to measure this change's growth...`);
		const build = spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "build"], {
			cwd: root,
			encoding: "utf8",
			maxBuffer: 1 << 28,
		});
		if (build.status !== 0) {
			console.error(String(build.stderr).slice(-4000));
			throw new Error("the base commit did not build");
		}
		const measured = await measure(root);
		for (const kind of ["client", "worker"]) delete measured[kind].largest;
		await fs.writeFile(cache, JSON.stringify(measured, null, 2));
		return measured;
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
}

/** The growth allowance files this change adds (those not already in the base). */
async function addedAllowances(sha) {
	let present;
	try {
		present = new Set(git("ls-tree", "-r", "--name-only", sha, "--", ALLOWANCE_DIRECTORY).split("\n"));
	} catch {
		present = new Set();
	}
	let names = [];
	try {
		names = await fs.readdir(ALLOWANCE_DIRECTORY);
	} catch {
		// No allowance directory: nothing added.
	}
	const allowances = [];
	const problems = [];
	for (const name of names.sort()) {
		const relative = `${ALLOWANCE_DIRECTORY}/${name}`;
		if (present.has(relative)) continue;
		if (!isAllowanceFile(relative)) {
			problems.push(`${relative}: use a lowercase file name ending in .json`);
			continue;
		}
		const parsed = parseAllowance(await fs.readFile(relative, "utf8"), relative);
		problems.push(...parsed.problems);
		if (parsed.allowance) allowances.push(parsed.allowance);
	}
	return { allowances, problems };
}

const results = await measure(".");
const budgets = JSON.parse(await fs.readFile("scripts/quality/bundle-budgets.json"));
const problems = [];

let base = null;
let allowances = [];
const target = baseCommit();
if (target.sha) {
	try {
		base = await baseSizes(target.sha);
		const added = await addedAllowances(target.sha);
		allowances = added.allowances;
		problems.push(...added.problems);
	} catch (error) {
		console.warn(
			`::warning::Bundle growth was not compared with the base: ${error.message}. Only the ceiling applies.`,
		);
	}
} else console.log(`Bundle growth is not compared with a base (${target.reason}); only the ceiling applies.`);

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
