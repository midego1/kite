import { spawnSync } from "node:child_process";

// Knip's experimental raw-transfer parser reserves a large scratch buffer and
// fails in small development VMs. Use its supported standard parser instead.
const result = spawnSync(process.execPath, ["node_modules/knip/bin/knip.js", ...process.argv.slice(2)], {
	stdio: "inherit",
	env: { ...process.env, KNIP_DISABLE_RAW_TRANSFER: "1" },
});
if (result.error) {
	console.error(result.error.message);
	process.exit(1);
}
process.exit(result.status ?? 1);
