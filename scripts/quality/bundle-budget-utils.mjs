import { resolveBase } from "../release-check-utils.mjs";

export const KINDS = ["client", "worker"];
export const METRICS = ["bytes", "gzipBytes"];
export const ALLOWANCE_DIRECTORY = "bundle-growth.d";

const ALLOWANCE_NAME = /^[a-z0-9][a-z0-9._-]*\.json$/;

/** Whether `name` (a path relative to the repository root) is a growth allowance file. */
export function isAllowanceFile(name) {
	const [directory, file, ...rest] = name.split("/");
	return directory === ALLOWANCE_DIRECTORY && !rest.length && ALLOWANCE_NAME.test(file ?? "");
}

function isCount(value) {
	return Number.isSafeInteger(value) && value >= 0;
}

/**
 * Parses one allowance file: `{ "reason": "...", "client": { "bytes": n, "gzipBytes": n }, "worker": {...} }`.
 * Each number is extra growth this one pull request may add on top of the default limit. Returns
 * `{ allowance, problems }`; an invalid file contributes nothing, so it can never raise a limit by accident.
 */
export function parseAllowance(text, name = "allowance") {
	let value;
	try {
		value = JSON.parse(text);
	} catch {
		return { allowance: null, problems: [`${name}: not valid JSON`] };
	}
	const problems = [];
	if (!value || typeof value !== "object" || Array.isArray(value))
		return { allowance: null, problems: [`${name}: must be a JSON object`] };
	if (typeof value.reason !== "string" || value.reason.trim().length < 10)
		problems.push(`${name}: "reason" must say in a sentence why the bundle grows`);
	const allowance = { client: { bytes: 0, gzipBytes: 0 }, worker: { bytes: 0, gzipBytes: 0 } };
	let any = false;
	for (const key of Object.keys(value)) {
		if (key === "reason") continue;
		if (!KINDS.includes(key)) {
			problems.push(`${name}: unknown key "${key}"`);
			continue;
		}
		const entry = value[key];
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
			problems.push(`${name}: "${key}" must be an object`);
			continue;
		}
		for (const metric of Object.keys(entry)) {
			if (!METRICS.includes(metric)) problems.push(`${name}: unknown metric "${key}.${metric}"`);
			else if (!isCount(entry[metric])) problems.push(`${name}: "${key}.${metric}" must be a non-negative integer`);
			else {
				allowance[key][metric] = entry[metric];
				any = true;
			}
		}
	}
	if (!any && !problems.length) problems.push(`${name}: grants nothing; list at least one client or worker number`);
	return problems.length ? { allowance: null, problems } : { allowance, problems };
}

/** The default per-pull-request growth limits plus every allowance, per kind and metric. */
export function growthLimits(growth, allowances = []) {
	const limits = {};
	for (const kind of KINDS) {
		limits[kind] = {};
		for (const metric of METRICS)
			limits[kind][metric] =
				growth[kind][metric] + allowances.reduce((total, allowance) => total + allowance[kind][metric], 0);
	}
	return limits;
}

const bytes = (value) => value.toLocaleString("en-US");

/**
 * Compares a build with the budgets file and, when `base` (the same totals measured at the pull request's
 * base) is given, with the per-pull-request growth limits. Returns `{ problems, growth, limits }`; `growth`
 * is null without a base. A shrinking bundle never fails.
 */
export function checkBundles({ results, budgets, base = null, allowances = [] }) {
	const problems = [];
	for (const kind of KINDS)
		for (const metric of METRICS)
			if (results[kind][metric] > budgets[kind][metric])
				problems.push(
					`${kind} ${metric} is ${bytes(results[kind][metric])}, above the ${bytes(budgets[kind][metric])} ceiling in scripts/quality/bundle-budgets.json. Review the largest chunks; if the growth is justified, raise the ceiling in a pull request of its own.`,
				);
	if (!base) return { problems, growth: null, limits: null };
	const limits = growthLimits(budgets.growth, allowances);
	const growth = {};
	for (const kind of KINDS) {
		growth[kind] = {};
		for (const metric of METRICS) {
			growth[kind][metric] = results[kind][metric] - base[kind][metric];
			if (growth[kind][metric] > limits[kind][metric])
				problems.push(
					`${kind} ${metric} grew by ${bytes(growth[kind][metric])} against the base, above this pull request's limit of ${bytes(limits[kind][metric])}. Trim the change, or if the growth is justified add ${ALLOWANCE_DIRECTORY}/<slug>.json (see docs/quality.md).`,
				);
		}
	}
	return { problems, growth, limits };
}

/** One printable line per kind: totals, and the change against the base with its limit when known. */
export function describeBundles(results, growth, limits) {
	return KINDS.map((kind) => {
		const line = `${kind}: ${results[kind].files} JavaScript files, ${bytes(results[kind].bytes)} raw bytes, ${bytes(results[kind].gzipBytes)} gzip bytes`;
		if (!growth) return line;
		const change = (metric) => {
			const value = growth[kind][metric];
			return `${value > 0 ? "+" : ""}${bytes(value)} (limit ${bytes(limits[kind][metric])})`;
		};
		return `${line}; against the base: raw ${change("bytes")}, gzip ${change("gzipBytes")}`;
	});
}

/**
 * Which commit a build is compared with. `requested` (BUNDLE_BASE or --base) wins, and `none` skips the
 * comparison on purpose. Otherwise, on a pull request, it is the first parent of GitHub's merge commit (the
 * `main` the change merges onto); on any other CI event there is no base (`expected`); locally it is the
 * merge-base with origin/main. `git` runs a git command and returns its output or throws. Returns
 * `{ sha }`, or `{ reason, expected: true }` when no comparison is wanted, or `{ reason, expected: false }`
 * when one was wanted but the commit is not available.
 */
export function resolveBundleBase({ requested = "", env = {}, git }) {
	if (requested === "none") return { reason: "BUNDLE_BASE=none", expected: true };
	try {
		if (requested) return { sha: git("rev-parse", "--verify", `${requested}^{commit}`) };
		if (env.GITHUB_EVENT_NAME === "pull_request") {
			const sha = resolveBase(git, `origin/${env.GITHUB_BASE_REF || "main"}`, { pullRequest: true });
			return { sha: git("rev-parse", "--verify", `${sha}^{commit}`) };
		}
		if (env.GITHUB_EVENT_NAME) return { reason: `a ${env.GITHUB_EVENT_NAME} has no base`, expected: true };
		return { sha: git("merge-base", "HEAD", "origin/main") };
	} catch {
		return { reason: "the base commit is not available (fetch it, or pass --base <ref>)", expected: false };
	}
}

/**
 * The allowance files this change adds: those in `names` (the entries of bundle-growth.d) that the base
 * does not already have (`inBase`, relative paths such as `bundle-growth.d/a.json`). A file the base has
 * only mattered to the pull request that added it; a name that is not a valid allowance file is a problem.
 */
export function addedAllowanceFiles(names, inBase) {
	const files = [];
	const problems = [];
	for (const name of [...names].sort()) {
		const relative = `${ALLOWANCE_DIRECTORY}/${name}`;
		if (inBase.has(relative)) continue;
		if (isAllowanceFile(relative)) files.push(relative);
		else problems.push(`${relative}: use a lowercase file name ending in .json`);
	}
	return { files, problems };
}

/**
 * The budgets that apply to a comparison. The ceilings come from the checkout, so the dedicated pull
 * request that raises one passes; the growth limits come from the base commit's file, so a pull request
 * cannot raise its own limit and a raise only takes effect once it has merged. A base without `growth`
 * (before this check existed) falls back to the checkout's.
 */
export function effectiveBudgets(head, baseFile) {
	return { ...head, growth: baseFile?.growth ?? head.growth };
}
