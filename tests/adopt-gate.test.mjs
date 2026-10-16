import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const gate = new URL("../scripts/review/adopt-gate.mjs", import.meta.url).pathname;
const command = readFileSync(new URL("./fixtures/adopt-gate/command.mjs", import.meta.url), "utf8");

function fixture(t) {
	const root = mkdtempSync(join(tmpdir(), "kite-adopt-gate-test-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const cwd = join(root, "checkout");
	const bin = join(root, "bin");
	mkdirSync(bin);
	writeFileSync(join(bin, "package.json"), '{"type":"module"}');
	for (const name of ["git", "npm"]) {
		writeFileSync(join(bin, name), `#!${process.execPath}\n${command}`, { mode: 0o755 });
	}
	for (const name of ["checkout", "base", "head"]) {
		const directory = join(root, name);
		mkdirSync(join(directory, "node_modules"), { recursive: true });
		writeFileSync(join(directory, "source"), "working");
		writeFileSync(join(directory, "package-lock.json"), "base-dependencies");
		writeFileSync(join(directory, "node_modules", "version"), "base-dependencies");
	}
	const file = (name) => join(cwd, name);
	return {
		root,
		file,
		run: (env = {}) =>
			spawnSync(process.execPath, [gate], {
				cwd,
				env: {
					...process.env,
					BASE_SHA: "base",
					GITHUB_STEP_SUMMARY: "",
					GATE_FIXTURE: root,
					PATH: `${bin}:${process.env.PATH}`,
					...env,
				},
				encoding: "utf8",
			}),
		commands: () =>
			readFileSync(join(root, "commands.jsonl"), "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line)),
	};
}

test("compares failures with dependencies installed from the base lockfile", (t) => {
	const f = fixture(t);
	writeFileSync(f.file("package-lock.json"), "adopted-dependencies");
	writeFileSync(f.file("node_modules/version"), "adopted-dependencies");
	const result = f.run();
	assert.equal(result.status, 0, result.stderr);
	assert.deepEqual(JSON.parse(readFileSync(join(f.root, "reset.json"), "utf8")), ["reset", "--hard", "base"]);
	assert.equal(JSON.parse(readFileSync(f.file("replies.json"), "utf8"))[0].commentId, 777);
	const install = f.commands().find(({ command, args }) => command === "npm" && args[0] === "ci");
	assert.ok(install);
	assert.notEqual(install.cwd, join(f.root, "checkout"));
	assert.ok(!existsSync(install.cwd), "the comparison worktree is removed");
});

test("does not treat an unavailable base install as a preexisting check failure", (t) => {
	const f = fixture(t);
	writeFileSync(f.file("source"), "broken");
	const result = f.run({ GATE_INSTALL_FAIL: "1" });
	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /Could not install the base commit's dependencies/);
	assert.ok(!existsSync(join(f.root, "reset.json")));
	const install = f.commands().find(({ command, args }) => command === "npm" && args[0] === "ci");
	assert.ok(!existsSync(install.cwd), "a failed install still removes the worktree");
});
