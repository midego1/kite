import { execFileSync } from "node:child_process";
import { E2E_PERSIST_DIR } from "./constants";

/**
 * Makes a connected account at the fakes on 127.0.0.1 a known provider's (Fastmail) in the e2e database. Kite never
 * sends as an "Other" provider's address (the user chose the server, so its sign-in proves nothing about the address),
 * and a known preset cannot be pointed at a loopback fake through the API, so the spec changes the row itself, as
 * `ai-usage.ts` reads rows.
 */
export function markKnownProvider(address: string): void {
	execFileSync(
		"npx",
		[
			"wrangler",
			"d1",
			"execute",
			"DB",
			"--local",
			"--persist-to",
			E2E_PERSIST_DIR,
			"--command",
			`UPDATE external_accounts SET preset = 'fastmail' WHERE address = '${address.replace(/'/g, "''")}'`,
		],
		{ env: { ...process.env, CI: "1" }, stdio: ["ignore", "pipe", "pipe"] },
	);
}
