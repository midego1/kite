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
