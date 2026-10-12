import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_TASKS, planTasks } from "../scripts/quality/timings-utils.mjs";

test("the default list runs every task, including build:node", () => {
	const plan = planTasks([], {});
	assert.deepEqual(plan.selected, DEFAULT_TASKS);
	assert.deepEqual(plan.skipped, []);
	assert.ok(plan.selected.includes("build:node"));
});

test("MISSION_SKIP_TASKS=build:node skips only build:node and reports it", () => {
	const plan = planTasks([], { MISSION_SKIP_TASKS: "build:node" });
	assert.deepEqual(plan.skipped, ["build:node"]);
	assert.deepEqual(
		plan.selected,
		DEFAULT_TASKS.filter((task) => task !== "build:node"),
	);
});

test("CI skips build:node and test:e2e together, which run in parallel jobs", () => {
	const plan = planTasks([], { MISSION_SKIP_TASKS: "build:node,test:e2e" });
	assert.deepEqual(plan.skipped, ["build:node", "test:e2e"]);
	assert.deepEqual(
		plan.selected,
		DEFAULT_TASKS.filter((task) => task !== "build:node" && task !== "test:e2e"),
	);
	assert.ok(plan.selected.includes("build"));
	assert.ok(plan.selected.includes("test:relay:integration"));
});

test("an explicit task list ignores the skip variable", () => {
	const plan = planTasks(["build:node"], { MISSION_SKIP_TASKS: "build:node" });
	assert.deepEqual(plan, { selected: ["build:node"], skipped: [] });
});

test("an unsupported skip fails fast, even for an explicit list", () => {
	assert.throws(() => planTasks([], { MISSION_SKIP_TASKS: "check" }), /Unsupported skip task: check/);
	assert.throws(() => planTasks([], { MISSION_SKIP_TASKS: "build:node,quality:check" }), /Unsupported skip task/);
	assert.throws(() => planTasks(["build"], { MISSION_SKIP_TASKS: "lint" }), /Unsupported skip task/);
});

test("an empty variable skips nothing", () => {
	assert.deepEqual(planTasks([], { MISSION_SKIP_TASKS: "" }).skipped, []);
});
