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

test("an explicit task list ignores the skip variable", () => {
	const plan = planTasks(["build:node"], { MISSION_SKIP_TASKS: "build:node" });
	assert.deepEqual(plan, { selected: ["build:node"], skipped: [] });
});

test("an unsupported skip fails fast, even for an explicit list", () => {
	assert.throws(() => planTasks([], { MISSION_SKIP_TASKS: "test:e2e" }), /Unsupported skip task: test:e2e/);
	assert.throws(() => planTasks([], { MISSION_SKIP_TASKS: "build:node,check" }), /Unsupported skip task: check/);
	assert.throws(() => planTasks(["build"], { MISSION_SKIP_TASKS: "test:e2e" }), /Unsupported skip task/);
});

test("an empty variable skips nothing", () => {
	assert.deepEqual(planTasks([], { MISSION_SKIP_TASKS: "" }).skipped, []);
});
