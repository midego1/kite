// Recreates the isolated E2E state before the dev server starts: a fresh D1
// database with every migration applied, never the developer's .wrangler/state.
import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { resolve } from "node:path";

const persistDir = process.env.KITE_PERSIST_DIR;
if (!persistDir) throw new Error("KITE_PERSIST_DIR must be set for the E2E server");
const root = resolve(import.meta.dirname, "..");
const target = resolve(root, persistDir);
if (!target.startsWith(resolve(root, ".wrangler") + "/")) {
	throw new Error(`Refusing to wipe ${target}: the E2E state must live under .wrangler/`);
}

rmSync(target, { recursive: true, force: true });
execFileSync("node", ["scripts/generate-migration-bundle.mjs"], { cwd: root, stdio: "inherit" });
execFileSync("npx", ["wrangler", "d1", "migrations", "apply", "DB", "--local", "--persist-to", persistDir], {
	cwd: root,
	stdio: "inherit",
	env: { ...process.env, CI: "1" },
});
// A small stand-in for the database from before the rename to Kite, so the
// admin overview offers the move from the old install.
execFileSync(
	"npx",
	[
		"wrangler",
		"d1",
		"execute",
		"LEGACY_DB",
		"--local",
		"--persist-to",
		persistDir,
		"--command",
		"CREATE TABLE users (id TEXT PRIMARY KEY); CREATE TABLE messages (id TEXT PRIMARY KEY); INSERT INTO messages (id) VALUES ('legacy_1'), ('legacy_2');",
	],
	{ cwd: root, stdio: "inherit", env: { ...process.env, CI: "1" } },
);
