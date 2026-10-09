// Opt-in: `npm run hooks:install`. Nothing runs this on `npm install`.
import { existsSync, readdirSync, statSync } from "node:fs";
import { resolve, join } from "node:path";
import { spawnSync } from "node:child_process";

const git = (...args) => spawnSync("git", args, { encoding: "utf8" });

const inside = git("rev-parse", "--is-inside-work-tree");
if (inside.status !== 0 || inside.stdout.trim() !== "true") {
	console.log("No Git checkout found; hook installation skipped.");
	process.exit(0);
}

const configured = git("config", "--get", "core.hooksPath").stdout.trim();
const defaults = git("rev-parse", "--git-path", "hooks");
const directory = resolve(defaults.stdout.trim());
const customDefaults =
	!configured &&
	defaults.status === 0 &&
	existsSync(directory) &&
	readdirSync(directory).some((name) => !name.endsWith(".sample") && statSync(join(directory, name)).isFile());
if ((configured && configured !== ".githooks") || customDefaults) {
	console.log("Existing custom Git hooks preserved; run `npm run precommit:check` manually before committing.");
	process.exit(0);
}

// With extensions.worktreeConfig the setting stays in this worktree. Without it, --local is
// shared by every worktree of the clone; enabling the extension is left to the developer
// because it changes how Git reads config for all of them.
const perWorktree = git("config", "--bool", "--get", "extensions.worktreeConfig").stdout.trim() === "true";
const scope = perWorktree ? "--worktree" : "--local";
const result = spawnSync("git", ["config", scope, "core.hooksPath", ".githooks"], { stdio: "inherit" });
if (result.status !== 0) process.exit(result.status ?? 1);
console.log(
	`Installed the pre-commit documentation and formatting checks (git config ${scope} core.hooksPath .githooks).`,
);
if (!perWorktree)
	console.log(
		[
			"This applies to every worktree of this clone. To limit it to this worktree instead, run:",
			"  git config --local --unset core.hooksPath",
			"  git config extensions.worktreeConfig true",
			"  npm run hooks:install",
		].join("\n"),
	);
console.log(`Remove the hook again with: git config ${scope} --unset core.hooksPath`);
