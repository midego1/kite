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

/** The folder's `UIDNEXT` from EXAMINE, else from STATUS; null when the server names none (sizes cannot be walked). */
async function folderUidNext(session: ImapSession, folder: string): Promise<number | null> {
	const examined = await session.examine(folder);
	if (examined.uidNext !== null) return examined.uidNext;
	return (await session.status(folder))?.uidNext ?? null;
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
	now: () => number = Date.now,
): Promise<FolderSizeStep | null> {
	const session = await openImportSession(env, account);
	try {
		const uidNext = await folderUidNext(session, folder);
		if (uidNext === null) return null;
		const startedAt = now();
		let next = cursor;
		let messages = 0;
		let bytes = 0;
		for (let windows = 0; windows < limits.maxWindows; windows += 1) {
			const window = nextSizeWindow(next, uidNext, limits.windowUids);
			if (!window) {
				next = null;
				break;
			}
			const answered = await session.fetchSizes(window.from, window.to);
			// A server answers `n:m` with the UIDs inside it, but a stray unsolicited line must not be counted.
			const sum = sumSizes(answered.filter((entry) => entry.uid >= window.from && entry.uid <= window.to));
			messages += sum.messages;
			bytes += sum.bytes;
			next = window.from > 1 ? window.from - 1 : null;
			if (next === null || messages >= limits.stepMessages || now() - startedAt >= limits.maxMs) break;
		}
		return { messages, bytes, nextCursor: next, uidNext };
	} finally {
		await session.close();
	}
}
