import { and, asc, count, eq, gt, isNotNull, isNull, lt, sql } from "drizzle-orm";
import type { AppDatabase } from "@/db";
import { auditLogs } from "@/db/schema";
import { assistantSenderAddresses } from "@/db/schema/assistant-email";
import { allowAgentRequest } from "@/lib/agent/rate-limit";
import { hashSessionToken } from "@/lib/auth/session";
import { timingSafeEqual } from "@/lib/auth/totp";
import { missingColumnFromError } from "@/lib/auth/user-lookup-utils";
import { escapeHtml } from "@/lib/auth/password-reset-utils";
import { insertRow, selectRows } from "@/lib/db/pending-columns";
import { addressDomain } from "@/lib/external-accounts/presets-utils";
import { normalizeEmailAddress } from "@/lib/email/address";
import { isInstallDomain } from "@/lib/email/routing";
import { sendSystemEmail } from "@/lib/email/system-mail";
import { generateIdentityCode } from "@/lib/external-accounts/identity-code-utils";
import { getBranding } from "@/lib/branding/service";
import { createAuditLog } from "@/lib/mailboxes/audit";
import { newId } from "@/lib/ids";
import { isNoSuchTableError } from "@/lib/modules/state-utils";

/** At most this many verified-or-pending extra addresses per user (spec §5.3). */
const MAX_SENDER_ADDRESSES = 5;
const CODE_MINUTES = 30;

/** Wrong guesses one code allows before it is dropped; a new code resets this to 0 (security review). */
const MAX_CODE_ATTEMPTS = 5;

/** Code mails one user may ask for in an hour, independent of the burst rate limiter so it still holds without a
 * RateLimit binding (security review), counted the same way identity-verification.ts counts external account
 * codes. */
const CODES_PER_USER_PER_HOUR = 5;
const HOUR_MS = 60 * 60_000;

const CODE_REQUESTED_ACTION = "assistant_email.sender_code_requested";
const VERIFIED_ACTION = "assistant_email.sender_verified";
const VERIFY_FAILED_ACTION = "assistant_email.sender_verify_failed";
const REMOVED_ACTION = "assistant_email.sender_removed";

/** The column migration 0097 adds; an insert, update or whole-row read of this table may miss it. */
const ATTEMPTS_COLUMN = assistantSenderAddresses.attempts.name;

export type SenderAddressRow = {
	id: string;
	address: string;
	verified: boolean;
	createdAt: Date;
};

/** The error every route maps to 409 `MIGRATION_PENDING`. */
export class SenderAddressesPendingError extends Error {
	constructor() {
		super("Apply the pending database update first");
		this.name = "SenderAddressesPendingError";
	}
}

export type AddSenderAddressResult =
	{ ok: true } | { ok: false; error: string; code: "INSTALL_DOMAIN" | "RATE_LIMITED" };

function toRow(row: typeof assistantSenderAddresses.$inferSelect): SenderAddressRow {
	return { id: row.id, address: row.address, verified: !!row.verifiedAt, createdAt: row.createdAt };
}

/** Whether `error` is this table missing (pre-0096) or its `attempts` column missing (pre-0097). */
function isSenderAddressesPending(error: unknown): boolean {
	return isNoSuchTableError(error) || missingColumnFromError(error) === ATTEMPTS_COLUMN;
}

/** Audit rows of `action` by `actorUserId` since `since` (the hourly code-request cap). */
async function countAudit(db: AppDatabase, action: string, actorUserId: string, since: Date): Promise<number> {
	const [row] = await db
		.select({ total: count() })
		.from(auditLogs)
		.where(and(eq(auditLogs.action, action), eq(auditLogs.actorUserId, actorUserId), gt(auditLogs.createdAt, since)));
	return row?.total ?? 0;
}

/** The user's own verified and pending extra addresses; never the code hash. */
export async function listSenderAddresses(db: AppDatabase, userId: string): Promise<SenderAddressRow[]> {
	try {
		const rows = await selectRows(
			db,
			assistantSenderAddresses,
			eq(assistantSenderAddresses.userId, userId),
			undefined,
			asc(assistantSenderAddresses.createdAt),
		);
		return rows.map(toRow);
	} catch (error) {
		if (isNoSuchTableError(error)) return [];
		throw error;
	}
}

/**
 * Adds an address, pending verification (spec §5.3): generates a single-use code, valid 30 minutes, and emails
 * it to the address itself — never a sign that the address exists or belongs to someone else, so this cannot be
 * used to probe who uses Kite's assistant (the same anti-enumeration posture as password reset). The caller
 * always shows the same "code sent" state for every `ok: true` outcome, whichever branch below produced it.
 *
 * Refuses an address on any domain of this install outright (security review): a shared mailbox there could let
 * anyone with send-as access verify its address as their own "extra" one and command another user's assistant.
 * This is not a privacy-sensitive refusal — which domains this install owns is already public — so it is a
 * visible error, like the hourly rate limit, rather than folded into the silent "nothing happens" outcomes below.
 */
export async function addSenderAddress(
	env: CloudflareEnv,
	db: AppDatabase,
	userId: string,
	address: string,
): Promise<AddSenderAddressResult> {
	const normalized = normalizeEmailAddress(address);
	if (!normalized) return { ok: true };

	const hostname = addressDomain(normalized);
	if (hostname && (await isInstallDomain(db, hostname)))
		return {
			ok: false,
			code: "INSTALL_DOMAIN",
			error: "Add an address outside this Kite install: a mailbox here could let someone else command your assistant.",
		};

	const hourAgo = new Date(Date.now() - HOUR_MS);
	if ((await countAudit(db, CODE_REQUESTED_ACTION, userId, hourAgo)) >= CODES_PER_USER_PER_HOUR)
		return {
			ok: false,
			code: "RATE_LIMITED",
			error: "Too many codes were requested. Wait an hour before asking for another.",
		};

	let existingCount: number;
	try {
		existingCount = (await selectRows(db, assistantSenderAddresses, eq(assistantSenderAddresses.userId, userId)))
			.length;
	} catch (error) {
		if (isSenderAddressesPending(error)) throw new SenderAddressesPendingError();
		throw error;
	}
	if (existingCount >= MAX_SENDER_ADDRESSES) return { ok: true };

	const code = generateIdentityCode();
	const codeHash = await hashSessionToken(code);
	const codeExpiresAt = new Date(Date.now() + CODE_MINUTES * 60 * 1000);

	try {
		// A pending row for this exact address that expired without ever being verified must not block a fresh
		// attempt forever (security review): it is cleared first, so the insert below starts clean. A verified
		// row, or one still within its window, is never touched here and still refuses the insert just below.
		await db
			.delete(assistantSenderAddresses)
			.where(
				and(
					eq(assistantSenderAddresses.address, normalized),
					isNull(assistantSenderAddresses.verifiedAt),
					lt(assistantSenderAddresses.codeExpiresAt, new Date()),
				),
			);
		await insertRow(db, assistantSenderAddresses, {
			id: newId("ases"),
			userId,
			address: normalized,
			codeHash,
			codeExpiresAt,
		});
	} catch (error) {
		if (isSenderAddressesPending(error)) throw new SenderAddressesPendingError();
		// The unique index refused it: either this user already has it (resend the code below is skipped on
		// purpose, since re-adding an address they already added is a no-op) or it belongs to someone else — either
		// way nothing in the response may say which, so the function simply returns having sent nothing new.
		return { ok: true };
	}

	await createAuditLog(env, {
		actorUserId: userId,
		action: CODE_REQUESTED_ACTION,
		metadata: { address: normalized },
	});

	const { appName } = await getBranding(env);
	await sendSystemEmail(env, {
		to: normalized,
		subject: `Your code for ${appName}'s assistant`,
		text: [
			`Use this code to verify this address for ${appName}'s assistant by email:`,
			"",
			code,
			"",
			`It expires in ${CODE_MINUTES} minutes. If you did not request this, you can ignore this message.`,
		].join("\n"),
		html: `<p>Use this code to verify this address for ${escapeHtml(appName)}'s assistant by email:</p><p style="font-size:1.5em;font-weight:600;letter-spacing:0.1em">${escapeHtml(code)}</p><p>It expires in ${CODE_MINUTES} minutes. If you did not request this, you can ignore this message.</p>`,
	});
	return { ok: true };
}

/**
 * Verifies a pending address with its code; false for a wrong code, an expired one, or someone else's row. One
 * attempt is taken from the code before it is compared, in the same statement that also checks the expiry and
 * the limit, so parallel guesses can never get past `MAX_CODE_ATTEMPTS` (security review); the hashes are
 * compared in constant time. The right code verifies the address and clears it (single use); the last wrong one
 * drops the code so a new one is needed.
 */
export async function verifySenderAddress(
	env: CloudflareEnv,
	db: AppDatabase,
	userId: string,
	id: string,
	code: string,
): Promise<boolean> {
	if (!(await allowAgentRequest(env, `assistant-email-verify:${userId}`))) return false;
	const now = new Date();
	let claimed: { codeHash: string | null; attempts: number; address: string } | undefined;
	try {
		[claimed] = await db
			.update(assistantSenderAddresses)
			.set({ attempts: sql`${assistantSenderAddresses.attempts} + 1` })
			.where(
				and(
					eq(assistantSenderAddresses.id, id),
					eq(assistantSenderAddresses.userId, userId),
					isNull(assistantSenderAddresses.verifiedAt),
					isNotNull(assistantSenderAddresses.codeHash),
					gt(assistantSenderAddresses.codeExpiresAt, now),
					lt(assistantSenderAddresses.attempts, MAX_CODE_ATTEMPTS),
				),
			)
			.returning({
				codeHash: assistantSenderAddresses.codeHash,
				attempts: assistantSenderAddresses.attempts,
				address: assistantSenderAddresses.address,
			});
	} catch (error) {
		if (isSenderAddressesPending(error)) throw new SenderAddressesPendingError();
		throw error;
	}
	if (!claimed?.codeHash) return false;
	const candidate = await hashSessionToken(code);
	if (!timingSafeEqual(claimed.codeHash, candidate)) {
		const left = MAX_CODE_ATTEMPTS - claimed.attempts;
		if (left <= 0)
			await db
				.update(assistantSenderAddresses)
				.set({ codeHash: null, codeExpiresAt: null })
				.where(and(eq(assistantSenderAddresses.id, id), eq(assistantSenderAddresses.codeHash, claimed.codeHash)));
		await createAuditLog(env, {
			actorUserId: userId,
			action: VERIFY_FAILED_ACTION,
			metadata: { addressId: id, attemptsLeft: Math.max(left, 0) },
		});
		return false;
	}
	await db
		.update(assistantSenderAddresses)
		.set({ verifiedAt: now, codeHash: null, codeExpiresAt: null, attempts: 0 })
		.where(and(eq(assistantSenderAddresses.id, id), eq(assistantSenderAddresses.codeHash, claimed.codeHash)));
	await createAuditLog(env, {
		actorUserId: userId,
		action: VERIFIED_ACTION,
		metadata: { addressId: id, address: claimed.address },
	});
	return true;
}

/** Removes the user's own address; a no-op (not an error) for someone else's id or one already gone. */
export async function removeSenderAddress(
	env: CloudflareEnv,
	db: AppDatabase,
	userId: string,
	id: string,
): Promise<void> {
	let removed: { address: string }[];
	try {
		removed = await db
			.delete(assistantSenderAddresses)
			.where(and(eq(assistantSenderAddresses.id, id), eq(assistantSenderAddresses.userId, userId)))
			.returning({ address: assistantSenderAddresses.address });
	} catch (error) {
		if (isNoSuchTableError(error)) throw new SenderAddressesPendingError();
		throw error;
	}
	if (removed.length === 0) return;
	await createAuditLog(env, {
		actorUserId: userId,
		action: REMOVED_ACTION,
		metadata: { addressId: id, address: removed[0].address },
	});
}
