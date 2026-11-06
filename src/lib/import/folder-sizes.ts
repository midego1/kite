import { openImportSession } from "./imap";
import type { SignInGuard } from "./sign-in-limit";
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

/**
 * One bounded step of measuring a folder's size without STATUS=SIZE (RFC 8438): `FETCH n:m (UID RFC822.SIZE)` over
 * windows of sequence numbers from the newest down, until the step has seen `stepMessages` messages or run `maxMs`.
 * Sequence numbers are dense, so a folder takes about one step per 10,000 messages however sparse its UIDs are. The caller
 * repeats with `nextCursor` until it is null and adds the steps up, so no request holds more than one step in memory
 * (about 10,000 answer lines) and nothing is stored between steps. A message deleted between steps can shift the
 * numbers by one, so the sum is a preview. Null when the server does not say how many messages the folder holds.
 * An aborted request (`signal`, the page moved on) closes the session at once. A `guard` counts a failed sign-in
 * against the user's limit; a step that signs in and measures never does.
 */
export async function measureFolderStep(
	env: SizeEnv,
	account: ImapAccount,
	folder: string,
	cursor: number | null,
	limits: SizeStepLimits = DEFAULT_SIZE_STEP_LIMITS,
	now: () => number = Date.now,
	signal?: AbortSignal,
	guard?: SignInGuard,
): Promise<FolderSizeStep | null> {
	signal?.throwIfAborted();
	// An abort closes the connection, wherever the request is (signing in, or waiting for an answer).
	const session = await openImportSession(env, account, signal, guard);
	try {
		const examined = await session.examine(folder);
		const exists = examined.exists ?? (await session.status(folder))?.messages ?? null;
		if (exists === null) return null;
		const startedAt = now();
		let next = cursor;
		let messages = 0;
		let bytes = 0;
		let unsized = 0;
		for (let windows = 0; windows < limits.maxWindows; windows += 1) {
			signal?.throwIfAborted();
			const window = nextSizeWindow(next, exists, limits.windowMessages);
			if (!window) {
				next = null;
				break;
			}
			const sum = sumSizes(await session.fetchSizes(window.from, window.to));
			messages += sum.messages;
			bytes += sum.bytes;
			unsized += sum.unsized;
			next = window.from > 1 ? window.from - 1 : null;
			if (next === null || messages >= limits.stepMessages || now() - startedAt >= limits.maxMs) break;
		}
		return { messages, bytes, unsized, nextCursor: next, exists, uidValidity: examined.uidValidity };
	} finally {
		await session.close().catch(() => undefined);
	}
}
