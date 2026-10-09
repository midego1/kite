import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const mode = process.argv[2];
if (mode && !["--list", "--coverage"].includes(mode)) throw new Error("Use --list or --coverage");
const root = fileURLToPath(new URL("../", import.meta.url));
const directory = join(root, "deploy/cloudflare-email-relay/tests");
const tests = readdirSync(directory)
	.filter((name) => name.endsWith(".test.mjs"))
	.sort()
	.map((name) => join(directory, name));
if (!tests.length) throw new Error("No relay tests discovered");
const flags =
	mode === "--coverage"
		? [
				"--experimental-test-coverage",
				"--test-coverage-include=deploy/cloudflare-email-relay/src/index.ts",
				"--test-coverage-lines=90",
				"--test-coverage-functions=90",
				"--test-coverage-branches=80",
			]
		: [];
const result = spawnSync(process.execPath, ["--experimental-strip-types", ...flags, "--test", ...tests], {
	cwd: root,
	stdio: "inherit",
	// Discovery skips every body; regular and coverage runs always execute them,
	// even if a caller's environment happens to contain the discovery flag.
	env: { ...process.env, KITE_TEST_DISCOVERY: mode === "--list" ? "1" : "0" },
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
