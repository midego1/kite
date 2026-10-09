export const DEFAULT_TASKS = [
	"check",
	"test:coverage",
	"quality:check",
	"docs:check",
	"build",
	"build:node",
	"quality:report",
	"test:relay:integration",
	"test:e2e",
];

// Only build:node may be skipped: CI runs it in a parallel job, and every other task is evidence the gate needs.
export const SKIPPABLE_TASKS = ["build:node"];

export function parseSkipTasks(value) {
	const entries = String(value ?? "")
		.split(",")
		.map((entry) => entry.trim())
		.filter(Boolean);
	for (const entry of entries) {
		if (!SKIPPABLE_TASKS.includes(entry)) throw new Error(`Unsupported skip task: ${entry}`);
	}
	return new Set(entries);
}

// An explicit task list always runs in full; the variable only trims the default list.
export function planTasks(argv, env = {}) {
	const skip = parseSkipTasks(env.MISSION_SKIP_TASKS);
	if (argv.length) return { selected: argv, skipped: [] };
	return {
		selected: DEFAULT_TASKS.filter((task) => !skip.has(task)),
		skipped: DEFAULT_TASKS.filter((task) => skip.has(task)),
	};
}
