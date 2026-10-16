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
		writeFileSync(join(directory, "revision"), name);
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
	writeFileSync(join(f.root, "head", "package-lock.json"), "adopted-dependencies");
	const result = f.run();
	assert.equal(result.status, 0, result.stderr);
	assert.deepEqual(JSON.parse(readFileSync(join(f.root, "reset.json"), "utf8")), ["reset", "--hard", "base"]);
	assert.equal(JSON.parse(readFileSync(f.file("replies.json"), "utf8"))[0].commentId, 777);
	const installs = f.commands().filter(({ command, args }) => command === "npm" && args[0] === "ci");
	assert.equal(installs.length, 2);
	for (const install of installs) {
		assert.notEqual(install.cwd, join(f.root, "checkout"));
		assert.ok(!existsSync(install.cwd), "the comparison worktree is removed");
	}
});

test("does not treat an unavailable base install as a preexisting check failure", (t) => {
	const f = fixture(t);
	writeFileSync(join(f.root, "head", "source"), "broken");
	const result = f.run({ GATE_INSTALL_FAIL: "base" });
	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /Could not install dependencies for base/);
	assert.ok(!existsSync(join(f.root, "reset.json")));
	const installs = f.commands().filter(({ command, args }) => command === "npm" && args[0] === "ci");
	assert.equal(installs.length, 2);
	assert.ok(
		installs.every(({ cwd }) => !existsSync(cwd)),
		"a failed install still removes the worktree",
	);
});

test("an uncommitted repair cannot make a broken committed adoption pass", (t) => {
	const f = fixture(t);
	writeFileSync(join(f.root, "head", "source"), "broken");
	const replies = [{ commentId: 888, body: "The existing answer is preserved." }];
	writeFileSync(f.file("replies.json"), JSON.stringify(replies));
	writeFileSync(f.file("untracked-repair"), "not committed");
	const result = f.run();
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /Dropped 1 adoption commit/);
	assert.equal(readFileSync(f.file("source"), "utf8"), "working");
	assert.equal(readFileSync(f.file("untracked-repair"), "utf8"), "not committed");
	const answers = JSON.parse(readFileSync(f.file("replies.json"), "utf8"));
	assert.deepEqual(answers[0], replies[0]);
	assert.equal(answers[1].commentId, 777);
	assert.ok(
		f
			.commands()
			.filter(({ command }) => command === "npm")
			.every(({ cwd }) => cwd !== join(f.root, "checkout")),
	);
});

test("unfinished working changes do not reject passing committed adoptions", (t) => {
	const f = fixture(t);
	writeFileSync(f.file("source"), "broken");
	const result = f.run();
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /The adoptions pass/);
	assert.ok(!existsSync(join(f.root, "reset.json")));
	assert.equal(readFileSync(f.file("source"), "utf8"), "broken");
});

test("a failure present in both committed revisions does not drop adoptions", (t) => {
	const f = fixture(t);
	for (const revision of ["head", "base"]) writeFileSync(join(f.root, revision, "source"), "broken");
	const result = f.run();
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /Already failing before this run/);
	assert.ok(!existsSync(join(f.root, "reset.json")));
});

for (const [name, contents] of [
	["missing", undefined],
	["partial", '[{"commentId":'],
	["object", "{}"],
	["null", "null"],
	["string", '"unfinished"'],
	["null entry", "[null]"],
	[
		"invalid entries",
		JSON.stringify([
			null,
			false,
			777,
			"unfinished",
			[],
			{},
			{ commentId: null, body: "Unusable id." },
			{ commentId: "777", body: "String id." },
			{ commentId: 0, body: "Zero id." },
			{ commentId: -777, body: "Negative id." },
			{ commentId: 7.77, body: "Fractional id." },
			{ commentId: Number.MAX_SAFE_INTEGER + 1, body: "Unsafe id." },
			{ commentId: 777 },
			{ commentId: 777, body: null },
			{ commentId: 777, body: 123 },
			{ commentId: 777, body: " \n\t" },
		]),
	],
]) {
	test(`recovers ${name} replies when rejecting an adoption`, (t) => {
		const f = fixture(t);
		writeFileSync(join(f.root, "head", "source"), "broken");
		if (contents !== undefined) writeFileSync(f.file("replies.json"), contents);
		const result = f.run();
		assert.equal(result.status, 0, result.stderr);
		assert.match(result.stdout, /Dropped 1 adoption commit/);
		const replies = JSON.parse(readFileSync(f.file("replies.json"), "utf8"));
		assert.equal(replies.length, 1);
		assert.equal(replies[0].commentId, 777);
		assert.match(replies[0].body, /^Valid, not adopted:/);
		assert.ok(existsSync(join(f.root, "reset.json")));
	});
}

test("keeps valid replies among invalid entries when rejecting an adoption", (t) => {
	const f = fixture(t);
	writeFileSync(join(f.root, "head", "source"), "broken");
	const replies = [
		{ commentId: 888, body: "The existing answer is preserved." },
		{ commentId: 777, body: "Valid, not adopted: the fix could not be kept." },
	];
	writeFileSync(f.file("replies.json"), JSON.stringify([null, replies[0], {}, replies[1]]));
	const result = f.run();
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /Dropped 1 adoption commit/);
	assert.deepEqual(JSON.parse(readFileSync(f.file("replies.json"), "utf8")), replies);
	assert.ok(existsSync(join(f.root, "reset.json")));
});
