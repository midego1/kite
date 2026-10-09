import { readFileSync } from "node:fs";
import { planDeployment, recordDeployment } from "./deploy-record-utils.mjs";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const eventIndex = args.indexOf("--event");
const eventPath = eventIndex === -1 ? undefined : args[eventIndex + 1];

if (!eventPath) {
	console.error("Usage: deploy-record.mjs --event <path> [--dry-run]");
	process.exit(2);
}

const plan = planDeployment(JSON.parse(readFileSync(eventPath, "utf8")));

if (plan.skip) {
	console.log(JSON.stringify(plan, null, 2));
	process.exit(0);
}

if (dryRun) {
	console.log(JSON.stringify(plan, null, 2));
	process.exit(0);
}

const token = process.env.GITHUB_TOKEN;
const repo = process.env.GITHUB_REPOSITORY;
if (!token || !repo) {
	console.error("GITHUB_TOKEN and GITHUB_REPOSITORY are required");
	process.exit(2);
}

try {
	const result = await recordDeployment(plan, { fetch, token, repo });
	console.log(`Recorded ${plan.state} for ${plan.environment} (deployment ${result.deploymentId})`);
} catch (error) {
	console.error(error instanceof Error ? error.message : "recording failed");
	process.exit(1);
}
