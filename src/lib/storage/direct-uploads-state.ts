import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { storageState } from "@/db/schema/storage";
import type { R2SetupStepId } from "./cloudflare-r2-utils";

/** What the last automatic setup did; a plain-language reason, never a key, a token or Cloudflare's raw answer. */
export type DirectUploadsSetupRecord = {
	ok: boolean;
	at: string;
	source: "install" | "admin";
	step?: R2SetupStepId;
	message?: string;
	permission?: string | null;
};

export type DirectUploadsState = { setup?: DirectUploadsSetupRecord; dismissedAt?: string };

/** Before migration 0085 the table is missing: reads see an empty state and dismissing waits for the update. */
export class DirectUploadsStatePendingError extends Error {
	constructor() {
		super("Apply the pending database update first");
	}
}

/** D1 and better-sqlite3 both say "no such table: storage_state", possibly inside a wrapped Drizzle error. */
function isMissingTable(error: unknown): boolean {
	for (let current: unknown = error; current instanceof Error; current = (current as { cause?: unknown }).cause)
		if (/no such table:? storage_state/i.test(current.message)) return true;
	return false;
}

function parse(value: string | null | undefined): DirectUploadsState {
	if (!value) return {};
	try {
		const parsed = JSON.parse(value) as DirectUploadsState;
		return parsed && typeof parsed === "object" ? parsed : {};
	} catch {
		return {};
	}
}

export async function readDirectUploadsState(env: CloudflareEnv): Promise<DirectUploadsState> {
	try {
		const [row] = await getDb(env)
			.select({ value: storageState.directUploads })
			.from(storageState)
			.where(eq(storageState.id, "default"))
			.limit(1);
		return parse(row?.value);
	} catch (error) {
		if (isMissingTable(error)) return {};
		throw error;
	}
}

async function writeState(env: CloudflareEnv, state: DirectUploadsState): Promise<void> {
	const values = { directUploads: JSON.stringify(state), updatedAt: new Date() };
	try {
		await getDb(env)
			.insert(storageState)
			.values({ id: "default", ...values })
			.onConflictDoUpdate({ target: storageState.id, set: values });
	} catch (error) {
		if (isMissingTable(error)) throw new DirectUploadsStatePendingError();
		throw error;
	}
}

/** Remembers the outcome of an automatic setup; a database that is behind only loses the note. */
export async function recordDirectUploadsSetup(env: CloudflareEnv, setup: DirectUploadsSetupRecord): Promise<void> {
	try {
		await writeState(env, { ...(await readDirectUploadsState(env)), setup });
	} catch (error) {
		if (!(error instanceof DirectUploadsStatePendingError)) throw error;
	}
}

/** Hides the "Direct uploads are off" reminder on the Storage page and the Admin overview. */
export async function dismissDirectUploadsReminder(env: CloudflareEnv, dismissed: boolean): Promise<void> {
	const { dismissedAt: _previous, ...state } = await readDirectUploadsState(env);
	await writeState(env, dismissed ? { ...state, dismissedAt: new Date().toISOString() } : state);
}
