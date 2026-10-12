import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);

/**
 * The time this bundle was built, as an ISO string. `SOURCE_DATE_EPOCH` pins it
 * for reproducible builds; otherwise it is the moment the build started.
 */
function getBuildTime(env) {
	const pinned = Number(env.SOURCE_DATE_EPOCH);
	if (Number.isFinite(pinned) && pinned > 0) return new Date(pinned * 1000).toISOString();
	return new Date().toISOString();
}

/**
 * Build-time only: both runtimes embed the release from VERSION, the source
 * revision and the build time, which the sidebar footer shows as "Updated".
 */
export function getBuildVersion(env = process.env) {
	let commit = env.CF_PAGES_COMMIT_SHA || env.CF_BUILD_SHA || env.GITHUB_SHA || "";
	if (!/^[a-f0-9]{7,40}$/i.test(commit)) {
		try {
			commit = execFileSync("git", ["-C", fileURLToPath(root), "rev-parse", "HEAD"], {
				encoding: "utf8",
				stdio: ["ignore", "pipe", "ignore"],
			}).trim();
		} catch {
			commit = "";
		}
	}
	return {
		version: readFileSync(new URL("VERSION", root), "utf8").trim(),
		commit: /^[a-f0-9]{7,40}$/i.test(commit) ? commit.slice(0, 7) : "unknown",
		builtAt: getBuildTime(env),
	};
}
