import type { StartupStep, StartupStepsInput, StartupStepState } from "./startup-steps-types";

function plural(count: number, one: string, many = `${one}s`): string {
	return `${count} ${count === 1 ? one : many}`;
}

/** "1.4 s" below a minute, "1 min 05 s" above; never negative. */
function formatStartupElapsed(ms: number): string {
	const seconds = Math.max(0, Number.isFinite(ms) ? ms : 0) / 1000;
	if (seconds < 60) return `${seconds.toFixed(1)} s`;
	const minutes = Math.floor(seconds / 60);
	return `${minutes} min ${String(Math.round(seconds % 60)).padStart(2, "0")} s`;
}

/** What the mail line says once the mailboxes and the counts are known. */
function mailDetail(mailboxes: number | undefined, unread: number | undefined): string {
	const parts: string[] = [];
	if (mailboxes !== undefined) parts.push(plural(mailboxes, "mailbox", "mailboxes"));
	if (unread !== undefined) parts.push(`${unread} unread`);
	return parts.join(" · ");
}

/** What the database line says: "Up to date", or how many updates wait. */
function databaseDetail(pending: number | undefined): string {
	if (pending === undefined) return "";
	return pending > 0 ? `${plural(pending, "update")} waiting` : "Up to date";
}

/**
 * The five lines of the startup screen: loading the app, the session, the database, the mail, ready. Each line
 * is done once its fact is known (or the screen completes), the first line that is not done after its
 * predecessors is running, and the rest wait. Facts may arrive in any order, so a later line can be done while
 * an earlier one still runs; the planner only decides which one spins. Nothing here is ever made up: an unknown
 * fact shows an empty detail, also once the screen completes without it.
 */
export function planStartupSteps(input: StartupStepsInput): StartupStep[] {
	const { mounted, ready, complete, version, commit, stats, elapsedMs } = input;
	const mailKnown = stats.mailboxes !== undefined || stats.unread !== undefined;
	const facts = [
		{
			id: "load" as const,
			label: `Loading Kite v${version}`,
			detail: commit && commit !== "unknown" ? commit : "",
			known: mounted,
			warn: false,
		},
		{
			id: "session" as const,
			label: ready ? "Signed in" : "Signing you in…",
			detail: ready ? (stats.sessionName ?? "") : "",
			known: ready,
			warn: false,
		},
		{
			id: "database" as const,
			label: "Checking the database",
			detail: databaseDetail(stats.pendingMigrations),
			known: stats.pendingMigrations !== undefined,
			warn: (stats.pendingMigrations ?? 0) > 0,
		},
		{
			id: "mail" as const,
			label: "Loading your mail",
			detail: mailKnown ? mailDetail(stats.mailboxes, stats.unread) : "",
			known: mailKnown,
			warn: false,
		},
		{
			id: "ready" as const,
			label: "Ready",
			detail: complete ? formatStartupElapsed(elapsedMs) : "",
			known: complete,
			warn: false,
		},
	];
	// The database and the mail only start once the session is in; before that, the session line runs.
	let runningAssigned = false;
	return facts.map((fact, index): StartupStep => {
		let state: StartupStepState;
		const done = complete || fact.known;
		const blocked = index >= 2 && !ready;
		if (done) state = "done";
		else if (!runningAssigned && !blocked) {
			state = "running";
			runningAssigned = true;
		} else state = "todo";
		return { id: fact.id, label: fact.label, detail: fact.detail, state, warn: fact.warn && done };
	});
}

/** "STEP 3/5": the running line, or the last done one when nothing runs (every line done reads 5/5). */
export function startupStepCounter(steps: StartupStep[]): string {
	const running = steps.findIndex((step) => step.state === "running");
	const current = running >= 0 ? running + 1 : Math.max(1, steps.filter((step) => step.state === "done").length || 1);
	return `STEP ${Math.min(current, steps.length)}/${steps.length}`;
}

/** The line the status row names: the running one, else the last done one. */
export function currentStartupStep(steps: StartupStep[]): StartupStep | undefined {
	return steps.find((step) => step.state === "running") ?? [...steps].reverse().find((step) => step.state === "done");
}
