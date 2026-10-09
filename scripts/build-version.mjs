import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

/** Build-time only: both runtimes embed the same UTC date and source revision. */
export function getBuildVersion(date = new Date(), env = process.env) {
	let commit = env.CF_PAGES_COMMIT_SHA || env.CF_BUILD_SHA || env.GITHUB_SHA || "";
	if (!/^[a-f0-9]{7,40}$/i.test(commit)) {
		try {
			commit = execFileSync("git", ["-C", fileURLToPath(new URL("../", import.meta.url)), "rev-parse", "HEAD"], {
				encoding: "utf8",
				stdio: ["ignore", "pipe", "ignore"],
			}).trim();
		} catch {
			commit = "";
		}
	}
	return {
		version: date.toISOString().slice(0, 10).replaceAll("-", "."),
		commit: /^[a-f0-9]{7,40}$/i.test(commit) ? commit.slice(0, 7) : "unknown",
	};
}
