import fs from "node:fs/promises";
import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";
import { planTasks } from "./timings-utils.mjs";

const { selected, skipped } = planTasks(process.argv.slice(2), process.env);
const pkg = JSON.parse(await fs.readFile("package.json"));
for (const task of selected)
	if (!pkg.scripts[task] || ["check:mission", "quality:timings"].includes(task))
		throw new Error(`Unsupported timing task: ${task}`);
const report = { generatedAt: new Date().toISOString(), node: process.version, tasks: [] };
for (const task of skipped) {
	report.tasks.push({ task, skipped: true, reason: "MISSION_SKIP_TASKS" });
	console.log(`${task}: skipped (MISSION_SKIP_TASKS)`);
}
await fs.mkdir("test-results/quality", { recursive: true });
for (const task of selected) {
	const started = performance.now();
	const status = await new Promise((resolve, reject) => {
		const child = spawn(process.platform === "win32" ? "npm.cmd" : "npm", ["run", task], {
			stdio: "inherit",
			env: process.env,
		});
		child.on("error", reject);
		child.on("exit", (code, signal) => resolve({ exitCode: code ?? 1, signal }));
	});
	report.tasks.push({ task, durationMs: Math.round(performance.now() - started), ...status });
	await fs.mkdir("test-results/quality", { recursive: true });
	await fs.writeFile("test-results/quality/timings.json", JSON.stringify(report, null, 2));
	console.log(`${task}: ${report.tasks.at(-1).durationMs}ms (exit ${status.exitCode})`);
	if (status.exitCode !== 0) {
		process.exitCode = status.exitCode;
		break;
	}
}
