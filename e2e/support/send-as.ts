import { execFileSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { E2E_APP_ENCRYPTION_KEY, E2E_PERSIST_DIR } from "./constants";

/**
 * Makes a connected account at the fakes on 127.0.0.1 a known provider's (Fastmail) in the e2e database. Kite sends
 * as an "Other" provider's address only once it is verified with a code (the user chose the server, so its sign-in
 * proves nothing about the address; e2e/99-send-as-verification.spec.ts), and a known preset cannot be pointed at a
 * loopback fake through the API, so specs about sending itself change the row, as `ai-usage.ts` reads rows.
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

/**
 * The verification code Kite mailed to `address` for the account `accountId`. The local send binding keeps no mailbox
 * a spec can read, and Kite stores only an HMAC of the code (identity-code-utils.ts), so the spec reads the row and
 * tries all million codes against it with the e2e key: no code path exists for tests, and none could leak a code.
 */
export function readMailedCode(accountId: string, address: string): string {
	const quoted = (value: string) => `'${value.replace(/'/g, "''")}'`;
	const output = execFileSync(
		"npx",
		[
			"wrangler",
			"d1",
			"execute",
			"DB",
			"--local",
			"--persist-to",
			E2E_PERSIST_DIR,
			"--json",
			"--command",
			`SELECT id, code_hash AS codeHash FROM external_identities WHERE account_id = ${quoted(accountId)} AND address = ${quoted(address)}`,
		],
		{ env: { ...process.env, CI: "1" }, stdio: ["ignore", "pipe", "pipe"] },
	).toString();
	const [result] = JSON.parse(output) as { results: { id: string; codeHash: string | null }[] }[];
	const row = result.results[0];
	if (!row?.codeHash) throw new Error(`No code is waiting for ${address}`);
	const key = `kite.external-identity-code.v1:${E2E_APP_ENCRYPTION_KEY}`;
	for (let value = 0; value < 1_000_000; value++) {
		const code = String(value).padStart(6, "0");
		if (createHmac("sha256", key).update(`${row.id}:${code}`).digest("hex") === row.codeHash) return code;
	}
	throw new Error(`No code matches the one stored for ${address}`);
}
