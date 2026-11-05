import type { ImapSession } from "@/lib/imap/session";
import { openImportSession } from "./imap";
import type { ImapImportInput } from "./imap-types";
import {
	DEFAULT_SIZE_STEP_LIMITS,
	type FolderSizeStep,
	nextSizeWindow,
	type SizeStepLimits,
	sumSizes,
} from "./folder-size-utils";

type ImapAccount = Pick<ImapImportInput, "host" | "port" | "secure" | "username" | "password">;
type SizeEnv = Parameters<typeof openImportSession>[0];

/** The folder's UID namespace and next UID, falling back to STATUS when EXAMINE omits them. */
async function folderState(session: ImapSession, folder: string) {
	const examined = await session.examine(folder);
	const status = examined.uidNext === null || examined.uidValidity === null ? await session.status(folder) : null;
	return {
		uidNext: examined.uidNext ?? status?.uidNext ?? null,
		uidValidity: examined.uidValidity ?? status?.uidValidity ?? null,
	};
}

/**
 * One bounded step of measuring a folder's size without STATUS=SIZE (RFC 8438): `UID FETCH n:m (UID RFC822.SIZE)` over
 * UID windows from the newest down, until the step has seen `stepMessages` messages or run `maxMs`. The caller
 * repeats with `nextCursor` until it is null and adds the steps up, so no request holds more than one step in memory
 * (about 10,000 answer lines) and nothing is stored between steps. Null when the server names no `UIDNEXT`.
 */
export async function measureFolderStep(
	env: SizeEnv,
	account: ImapAccount,
	folder: string,
	cursor: number | null,
	limits: SizeStepLimits = DEFAULT_SIZE_STEP_LIMITS,
	options: { now?: () => number; signal?: AbortSignal; uidValidity?: number | null } = {},
): Promise<FolderSizeStep | null> {
	const { now = Date.now, signal } = options;
	const session = await openImportSession(env, account, signal);
	try {
		const { uidNext, uidValidity } = await folderState(session, folder);
		if (uidNext === null) return null;
		const reset = options.uidValidity != null && options.uidValidity !== uidValidity;
		const startedAt = now();
		let next = reset ? null : cursor;
		let messages = 0;
		let bytes = 0;
		for (let windows = 0; windows < limits.maxWindows; windows += 1) {
			signal?.throwIfAborted();
			const window = nextSizeWindow(next, uidNext, limits.windowUids);
			if (!window) {
				next = null;
				break;
			}
			const answered = await session.fetchSizes(window.from, window.to);
			signal?.throwIfAborted();
			// A server answers `n:m` with the UIDs inside it, but a stray unsolicited line must not be counted.
			const entries = answered.filter((entry) => entry.uid >= window.from && entry.uid <= window.to);
			// Missing sizes cannot establish a total. Let the page use its unknown-size estimate, never a partial sum.
			if (entries.some((entry) => entry.size === null)) return null;
			const sum = sumSizes(entries);
			messages += sum.messages;
			bytes += sum.bytes;
			next = window.from > 1 ? window.from - 1 : null;
			if (next === null || messages >= limits.stepMessages || now() - startedAt >= limits.maxMs) break;
		}
		return { messages, bytes, nextCursor: next, uidNext, uidValidity, reset };
	} finally {
		await session.close();
	}
}
