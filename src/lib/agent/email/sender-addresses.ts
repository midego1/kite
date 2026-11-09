import { and, asc, eq, gt, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import type { AppDatabase } from "@/db";
import { auditLogs } from "@/db/schema";
import { assistantSenderAddresses } from "@/db/schema/assistant-email";
import { allowAgentRequest } from "@/lib/agent/rate-limit";
import { hashSessionToken } from "@/lib/auth/session";
import { timingSafeEqual } from "@/lib/auth/totp";
import { missingColumnFromError } from "@/lib/auth/user-lookup-utils";
import { escapeHtml } from "@/lib/auth/password-reset-utils";
import { selectRows } from "@/lib/db/pending-columns";
import { addressDomain } from "@/lib/external-accounts/presets-utils";
import { normalizeEmailAddress } from "@/lib/email/address";
import { isInstallDomain } from "@/lib/email/routing";
import { sendSystemEmail } from "@/lib/email/system-mail";
import {
	CODE_WINDOW_MS,
	CODES_PER_ADDRESS,
	CODES_PER_ADDRESS_PER_DAY,
	CODES_PER_USER,
	DAY_MS,
	generateIdentityCode,
	MAX_FAILED_CODES_PER_DAY,
} from "@/lib/external-accounts/identity-code-utils";
import { getBranding } from "@/lib/branding/service";
import { createAuditLog } from "@/lib/mailboxes/audit";
import { newId } from "@/lib/ids";
import { isNoSuchTableError } from "@/lib/modules/state-utils";

/** At most this many verified-or-pending extra addresses per user (spec §5.3). */
const MAX_SENDER_ADDRESSES = 5;
const CODE_MINUTES = 30;

/** Wrong guesses one code allows before it is dropped; a new code resets this to 0 (security review). */
const MAX_CODE_ATTEMPTS = 5;

const CODE_REQUESTED_ACTION = "assistant_email.sender_code_requested";
const VERIFIED_ACTION = "assistant_email.sender_verified";
const VERIFY_FAILED_ACTION = "assistant_email.sender_verify_failed";
const REMOVED_ACTION = "assistant_email.sender_removed";

/** The column migration 0103 adds; an insert, update or whole-row read of this table may miss it. */
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
	{ ok: true } | { ok: false; error: string; code: "INSTALL_DOMAIN" | "RATE_LIMITED" | "LIMIT_REACHED" };

function toRow(row: typeof assistantSenderAddresses.$inferSelect): SenderAddressRow {
	return { id: row.id, address: row.address, verified: !!row.verifiedAt, createdAt: row.createdAt };
}

/** Whether `error` is a genuine "someone already holds this exact row" conflict, not a real failure to hide. */
function isUniqueViolation(error: unknown): boolean {
	return /UNIQUE constraint failed/i.test(
		error instanceof Error ? `${error.message} ${String(error.cause ?? "")}` : "",
	);
}

/**
 * Whether migration 0096 (the table) and 0103 (`attempts`) have both run, read straight from the schema rather
 * than through a failed query (security review should-fix): `addSenderAddress` checks this before writing
 * anything, so a deploy ahead of either migration never mails a code nobody could ever verify.
 */
async function senderAddressesReady(env: CloudflareEnv): Promise<boolean> {
	try {
		const { results } = await env.DB.prepare("PRAGMA table_info(assistant_sender_addresses)").all<{
			name: string;
		}>();
		return results.some((row) => row.name === ATTEMPTS_COLUMN);
	} catch {
		return false;
	}
}

/**
 * Atomically reserves one audit row for a code mail to `address`, unless doing so would push the requester past
 * `CODES_PER_USER` this hour, or the address itself past `CODES_PER_ADDRESS` this hour or `CODES_PER_ADDRESS_PER_DAY`
 * today (security review: the same three limits `identity-verification.ts` enforces for external accounts). The
 * `INSERT … SELECT … WHERE` is one statement: SQLite serialises writes, so every concurrent caller's count sees
 * every reservation that already committed, and at most the limit can ever succeed — there is nothing to roll back.
 * Returns whether the reservation was made; the caller counts this as the attempt either way it turns out (so a
 * conflict on the address a moment later still shows up against the requester's own hourly budget).
 */
async function reserveCodeRequest(db: AppDatabase, actorUserId: string, address: string, now: Date): Promise<boolean> {
	const hourAgo = new Date(now.getTime() - CODE_WINDOW_MS);
	const dayAgo = new Date(now.getTime() - DAY_MS);
	const metadata = JSON.stringify({ address });
	// SQLite's INSERT column list takes bare names, not the `table.column` form the sql`` template gives a Column
	// reference elsewhere in this statement, hence `sql.identifier`.
	const insertColumns = sql.join(
		[auditLogs.id, auditLogs.actorUserId, auditLogs.action, auditLogs.metadata, auditLogs.createdAt].map((column) =>
			sql.identifier(column.name),
		),
		sql`, `,
	);
	const result = await db.run(sql`
		insert into ${auditLogs} (${insertColumns})
		select ${newId("aud")}, ${actorUserId}, ${CODE_REQUESTED_ACTION}, ${metadata}, ${sql.param(now, auditLogs.createdAt)}
		where (
			select count(*) from ${auditLogs}
			where ${auditLogs.actorUserId} = ${actorUserId} and ${auditLogs.action} = ${CODE_REQUESTED_ACTION}
				and ${auditLogs.createdAt} > ${sql.param(hourAgo, auditLogs.createdAt)}
		) < ${CODES_PER_USER}
		and (
			select count(*) from ${auditLogs}
			where ${auditLogs.action} = ${CODE_REQUESTED_ACTION} and ${auditLogs.createdAt} > ${sql.param(hourAgo, auditLogs.createdAt)}
				and json_extract(${auditLogs.metadata}, '$.address') = ${address}
		) < ${CODES_PER_ADDRESS}
		and (
			select count(*) from ${auditLogs}
			where ${auditLogs.action} = ${CODE_REQUESTED_ACTION} and ${auditLogs.createdAt} > ${sql.param(dayAgo, auditLogs.createdAt)}
				and json_extract(${auditLogs.metadata}, '$.address') = ${address}
		) < ${CODES_PER_ADDRESS_PER_DAY}
	`);
	return result.meta.changes > 0;
}

/**
 * Atomically inserts a sender-address row unless `userId` already has `MAX_SENDER_ADDRESSES` (security review):
 * the count and the insert are one statement, so concurrent adds by the same user cannot all read "under the cap"
 * and all succeed. A conflict on the address's own unique index (someone already holds it, verified or still
 * pending) still throws, exactly as a plain insert would.
 */
async function insertSenderAddressRow(
	db: AppDatabase,
	id: string,
	userId: string,
	address: string,
	codeHash: string,
	codeExpiresAt: Date,
	now: Date,
): Promise<boolean> {
	const insertColumns = sql.join(
		[
			assistantSenderAddresses.id,
			assistantSenderAddresses.userId,
			assistantSenderAddresses.address,
			assistantSenderAddresses.codeHash,
			assistantSenderAddresses.codeExpiresAt,
			assistantSenderAddresses.createdAt,
		].map((column) => sql.identifier(column.name)),
		sql`, `,
	);
	const result = await db.run(sql`
		insert into ${assistantSenderAddresses} (${insertColumns})
		select ${id}, ${userId}, ${address}, ${codeHash}, ${sql.param(codeExpiresAt, assistantSenderAddresses.codeExpiresAt)}, ${sql.param(now, assistantSenderAddresses.createdAt)}
		where (select count(*) from ${assistantSenderAddresses} where ${assistantSenderAddresses.userId} = ${userId}) < ${MAX_SENDER_ADDRESSES}
	`);
	return result.meta.changes > 0;
}

/** Audit rows of `action` about `address` since `since` (the per-address daily failed-guess cap). */
async function countAuditByAddress(db: AppDatabase, action: string, address: string, since: Date): Promise<number> {
	const [row] = await db
		.select({ total: sql<number>`count(*)` })
		.from(auditLogs)
		.where(
			and(
				eq(auditLogs.action, action),
				gt(auditLogs.createdAt, since),
				sql`json_extract(${auditLogs.metadata}, '$.address') = ${address}`,
			),
		);
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
 * always shows the same "code sent" state for every `ok: true` outcome, whichever branch below produced it; the
 * attempt is still audited either way (security review should-fix), so a conflict on someone else's address
 * still counts against the requester's own hourly budget instead of being free to retry without limit.
 *
 * Refuses an address on any domain of this install outright (security review): a shared mailbox there could let
 * anyone with send-as access verify its address as their own "extra" one and command another user's assistant.
 * This is not a privacy-sensitive refusal — which domains this install owns is already public — so it is a
 * visible error, like the rate limits, rather than folded into the silent "nothing happens" outcomes below.
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

	// Checked before any write (security review should-fix): a deploy ahead of either migration must never mail
	// a code it could not let anyone verify later.
	if (!(await senderAddressesReady(env))) throw new SenderAddressesPendingError();

	// A burst limiter independent of the DB-level caps below: it catches a rapid retry fastest where a RateLimit
	// binding exists, but is a no-op without one (self-hosted Node), which is why the caps below are what
	// actually bounds this on every runtime (security review).
	if (!(await allowAgentRequest(env, `assistant-email-add:${userId}`)))
		return {
			ok: false,
			code: "RATE_LIMITED",
			error: "Too many codes were requested. Wait a minute before asking for another.",
		};

	const now = new Date();
	// A pending row for this exact address that can never be verified again — expired, or its code already used
	// up by wrong guesses — must not block a fresh attempt forever, for anyone (security review blocker): it is
	// cleared first, so the insert below starts clean. A verified row, or one still live within its own window
	// and attempts, is never touched here and still refuses the insert just below.
	await db
		.delete(assistantSenderAddresses)
		.where(
			and(
				eq(assistantSenderAddresses.address, normalized),
				isNull(assistantSenderAddresses.verifiedAt),
				or(
					isNull(assistantSenderAddresses.codeHash),
					isNull(assistantSenderAddresses.codeExpiresAt),
					lt(assistantSenderAddresses.codeExpiresAt, now),
				),
			),
		);

	// Too many wrong guesses against this address today refuses a new code too, not just more guessing
	// (identity-verification.ts's MAX_FAILED_CODES_PER_DAY): otherwise a new code every 30 minutes would let
	// guessing resume indefinitely.
	if (
		(await countAuditByAddress(db, VERIFY_FAILED_ACTION, normalized, new Date(now.getTime() - DAY_MS))) >=
		MAX_FAILED_CODES_PER_DAY
	)
		return {
			ok: false,
			code: "RATE_LIMITED",
			error: "Too many wrong codes were entered for this address today. Try again tomorrow.",
		};

	if (!(await reserveCodeRequest(db, userId, normalized, now)))
		return {
			ok: false,
			code: "RATE_LIMITED",
			error: "Too many codes were requested for this. Wait before asking for another.",
		};

	const code = generateIdentityCode();
	const codeHash = await hashSessionToken(code);
	const codeExpiresAt = new Date(now.getTime() + CODE_MINUTES * 60 * 1000);
	const id = newId("ases");
	try {
		if (!(await insertSenderAddressRow(db, id, userId, normalized, codeHash, codeExpiresAt, now)))
			// This user's own MAX_SENDER_ADDRESSES cap (the reservation above still counted): said out loud, since
			// "a code was sent" for an address that was never added would leave them waiting for a mail. It reveals
			// nothing about the address itself, only how many of their own they hold.
			return {
				ok: false,
				code: "LIMIT_REACHED",
				error: `You can have at most ${MAX_SENDER_ADDRESSES} extra addresses. Remove one to add another.`,
			};
	} catch (error) {
		if (!isUniqueViolation(error)) throw error;
		// Someone already holds this exact address (this user's own still-pending row, or another user's,
		// verified or not): nothing in the response may say which, so this returns having sent nothing new.
		return { ok: true };
	}

	// A thrown delivery failure (the provider itself rejected or errored on the attempt) must not leave a row
	// nobody can ever enter the code for: the row is removed again, so retrying the same address right away
	// gets a fresh attempt instead of having to wait for expiry or remove it by hand first (security review
	// should-fix). `sendSystemEmail` returning `false` is not this: it means no domain can send at all — every
	// future attempt would fail the exact same way, so this install already warns and moves on without deleting
	// anything, the same posture `requestPasswordReset` takes for the same reason. Either way `ok: true`, like a
	// real send, for the anti-enumeration reason above; a failure is only logged.
	try {
		const { appName } = await getBranding(env);
		const sent = await sendSystemEmail(env, {
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
		if (!sent) console.warn(`Assistant email: no domain can send mail; a code for ${normalized} was not delivered`);
	} catch (error) {
		console.error(`Assistant email: failed to send a verification code to ${normalized}`, error);
		// Scoped to the exact code just minted, so a verify that somehow already claimed this row first (it
		// cannot know the code before delivery, but this is cheap insurance) is never undone by this cleanup.
		await db
			.delete(assistantSenderAddresses)
			.where(and(eq(assistantSenderAddresses.id, id), eq(assistantSenderAddresses.codeHash, codeHash)));
	}
	return { ok: true };
}

/**
 * Verifies a pending address with its code; false for a wrong code, an expired one, or someone else's row. One
 * attempt is taken from the code before it is compared, in the same statement that also checks the expiry and
 * the limit, so parallel guesses can never get past `MAX_CODE_ATTEMPTS` (security review); the hashes are
 * compared in constant time. The right code verifies the address and clears it (single use); the last wrong one
 * drops the code so a new one is needed. The success update is keyed on the exact hash the guess was checked
 * against, and its own `.returning()` is checked (security review should-fix), so two concurrent correct
 * guesses — or a removal racing one — can audit a success at most once.
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
		const [existing] = await db
			.select({ address: assistantSenderAddresses.address })
			.from(assistantSenderAddresses)
			.where(and(eq(assistantSenderAddresses.id, id), eq(assistantSenderAddresses.userId, userId)))
			.limit(1);
		if (
			existing &&
			(await countAuditByAddress(db, VERIFY_FAILED_ACTION, existing.address, new Date(now.getTime() - DAY_MS))) >=
				MAX_FAILED_CODES_PER_DAY
		)
			return false;
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
		if (isNoSuchTableError(error) || missingColumnFromError(error)) throw new SenderAddressesPendingError();
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
			metadata: { addressId: id, address: claimed.address, attemptsLeft: Math.max(left, 0) },
		});
		return false;
	}
	const [verified] = await db
		.update(assistantSenderAddresses)
		.set({ verifiedAt: now, codeHash: null, codeExpiresAt: null, attempts: 0 })
		.where(and(eq(assistantSenderAddresses.id, id), eq(assistantSenderAddresses.codeHash, claimed.codeHash)))
		.returning({ id: assistantSenderAddresses.id });
	if (!verified) return false;
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
