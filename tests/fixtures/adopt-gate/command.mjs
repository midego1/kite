// Offline stand-ins for the gate's subprocesses. No real Git state or packages are changed.
import { appendFileSync, cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

const root = process.env.GATE_FIXTURE;
const command = basename(process.argv[1]);
const args = process.argv.slice(2);
const cwd = process.cwd();
appendFileSync(join(root, "commands.jsonl"), `${JSON.stringify({ command, args, cwd })}\n`);

if (command === "git") {
	switch (args[0]) {
		case "rev-list":
			console.log("adoption");
			break;
		case "diff-tree":
			console.log("package-lock.json");
			break;
		case "log":
			console.log("fix: synthetic adoption\n\nAddresses Greptile review comment 777 on pull request 9.");
			break;
		case "worktree":
			if (args[1] === "add") {
				cpSync(join(root, args[4] === "base" ? "base" : "head"), args[3], { recursive: true });
			} else if (args[1] === "remove") {
				rmSync(args[3], { recursive: true, force: true });
			} else {
				throw new Error(`Unexpected worktree command: ${args}`);
			}
			break;
		case "reset":
			writeFileSync(join(root, "reset.json"), JSON.stringify(args));
			break;
		default:
			throw new Error(`Unexpected git command: ${args}`);
	}
} else if (command === "npm") {
	if (args[0] === "ci") {
		if (process.env.GATE_INSTALL_FAIL === "1") process.exit(1);
		mkdirSync(join(cwd, "node_modules"), { recursive: true });
		writeFileSync(join(cwd, "node_modules", "version"), readFileSync(join(cwd, "package-lock.json")));
	} else if (args[0] === "run") {
		if (args[1] === "check") {
			const source = readFileSync(join(cwd, "source"), "utf8");
			const installed = readFileSync(join(cwd, "node_modules", "version"), "utf8");
			process.exit(source === "broken" || installed !== "base-dependencies" ? 1 : 0);
		}
	} else {
		throw new Error(`Unexpected npm command: ${args}`);
	}
} else {
	throw new Error(`Unexpected command: ${command}`);
}
