import { and, eq, gt, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { auditLogs } from "@/db/schema";
import { newId } from "@/lib/ids";
import {
	evaluateSignInAttempts,
	isAuthRefusal,
	SIGN_IN_ATTEMPT_ACTION,
	SIGN_IN_ROWS_READ,
	SIGN_IN_WINDOW_MS,
	signInLimitMessage,
	signInServerKey,
	type SignInLimitReason,
	type SignInVerdict,
} from "./sign-in-limit-utils";

/** Too many failed sign-ins; `retryAfterSeconds` is when the oldest failure that counts leaves the window. */
export class SignInLimitError extends Error {
	constructor(
		readonly retryAfterSeconds: number,
		readonly reason: SignInLimitReason = "failures",
	) {
		super(signInLimitMessage(retryAfterSeconds, reason));
		this.name = "SignInLimitError";
	}
}

/**
 * Runs the sign-in of `open` for the server `server` names. See `importSignInGuard`.
 */
export type SignInGuard = <T>(
	server: { host: string; port: number },
	open: () => Promise<T>,
	signal?: AbortSignal,
) => Promise<T>;

/**
 * The limit on signing in to a server the user names (the import form, the folder lists, the plan and the size steps,
 * and an import job's own runs), so the form cannot be used to guess passwords at a provider or to probe hosts. Only
 * **failed** sign-ins count, so measuring a 100,000-message folder in many successful steps is never limited.
 *
 * Each sign-in first writes an `import.sign_in_attempt` audit row and reads the user's rows in the window, its own
 * included; past 10 for the user, or 5 for the user and server, it is refused (`SignInLimitError`) and its row removed.
 * A sign-in that succeeds removes its row, so what stays are failures, and attempts still in flight, which is what
 * keeps parallel requests from all seeing room. A cancelled one (the page walked away) is marked instead and counts
 * only against limits of its own (per user and per server), since the password may have been sent before the cancel. No rate-limit binding is needed (works the same on Workers and Node);
 * when the row cannot be written or counted the sign-in is refused rather than allowed unchecked.
 */
export function importSignInGuard(env: CloudflareEnv, userId: string): SignInGuard {
	return async (server, open, signal) => {
		const serverKey = signInServerKey(server.host, server.port);
		const db = getDb(env);
		const id = newId("aud");
		const now = Date.now();
		// Tried twice, so one transient database error does not leave a finished attempt in the count.
		const released = async () => {
			for (let attempt = 0; attempt < 2; attempt += 1) {
				try {
					await db.delete(auditLogs).where(eq(auditLogs.id, id));
					return;
				} catch {
					// the next attempt, or the row stays (a failure at worst)
				}
			}
		};
		// A cancelled attempt may have sent the password already, so its row stays, marked, and has a limit of its own.
		const cancelled = () =>
			db
				.update(auditLogs)
				.set({ metadata: JSON.stringify({ server: serverKey, aborted: true }) })
				.where(eq(auditLogs.id, id))
				.catch(() => undefined);
		let verdict: SignInVerdict;
		try {
			await db.insert(auditLogs).values({
				id,
				actorUserId: userId,
				action: SIGN_IN_ATTEMPT_ACTION,
				metadata: JSON.stringify({ server: serverKey }),
				createdAt: new Date(now),
			});
			const rows = await db
				.select({
					at: auditLogs.createdAt,
					server: sql<string | null>`json_extract(${auditLogs.metadata}, '$.server')`,
					aborted: sql<number | null>`json_extract(${auditLogs.metadata}, '$.aborted')`,
				})
				.from(auditLogs)
				.where(
					and(
						eq(auditLogs.actorUserId, userId),
						eq(auditLogs.action, SIGN_IN_ATTEMPT_ACTION),
						gt(auditLogs.createdAt, new Date(now - SIGN_IN_WINDOW_MS)),
					),
				)
				.limit(SIGN_IN_ROWS_READ);
			verdict = evaluateSignInAttempts(
				rows.map((row) => ({ at: row.at.getTime(), server: row.server, aborted: !!row.aborted })),
				serverKey,
				now,
			);
		} catch (error) {
			// A database error's message carries the SQL; only its name is logged and the caller gets a plain refusal.
			console.error("import.sign_in_limit_failed", error instanceof Error ? error.name : "unknown");
			await released();
			throw new Error("The sign-in limit could not be checked. Try again.");
		}
		if (!verdict.allowed) {
			await released();
			throw new SignInLimitError(verdict.retryAfterSeconds, verdict.reason);
		}
		let session: Awaited<ReturnType<typeof open>>;
		try {
			session = await open();
		} catch (error) {
			// A request that was cancelled before the server answered is not a failed sign-in: closing the socket makes
			// the pending read fail with a plain error, so the signal says. A refusal the server had already sent stays.
			if ((signal?.aborted || (error instanceof Error && error.name === "AbortError")) && !isAuthRefusal(error))
				await cancelled();
			throw error;
		}
		await released();
		return session;
	};
}

/** The 429 answer for a refused sign-in, with `Retry-After`. */
export function signInLimitResponse(error: SignInLimitError): Response {
	return Response.json(
		{ error: error.message, code: "RATE_LIMITED", retryAfterSeconds: error.retryAfterSeconds },
		{ status: 429, headers: { "Retry-After": String(error.retryAfterSeconds), "Cache-Control": "no-store" } },
	);
}
