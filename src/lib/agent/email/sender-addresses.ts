import { and, eq, gt, isNull } from "drizzle-orm";
import type { AppDatabase } from "@/db";
import { assistantSenderAddresses } from "@/db/schema/assistant-email";
import { allowAgentRequest } from "@/lib/agent/rate-limit";
import { hashSessionToken } from "@/lib/auth/session";
import { escapeHtml } from "@/lib/auth/password-reset-utils";
import { normalizeEmailAddress } from "@/lib/email/address";
import { sendSystemEmail } from "@/lib/email/system-mail";
import { generateIdentityCode } from "@/lib/external-accounts/identity-code-utils";
import { getBranding } from "@/lib/branding/service";
import { newId } from "@/lib/ids";
import { isNoSuchTableError } from "@/lib/modules/state-utils";

/** At most this many verified-or-pending extra addresses per user (spec §5.3). */
const MAX_SENDER_ADDRESSES = 5;
const CODE_MINUTES = 30;

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

function toRow(row: typeof assistantSenderAddresses.$inferSelect): SenderAddressRow {
	return { id: row.id, address: row.address, verified: !!row.verifiedAt, createdAt: row.createdAt };
}

/** The user's own verified and pending extra addresses; never the code hash. */
export async function listSenderAddresses(db: AppDatabase, userId: string): Promise<SenderAddressRow[]> {
	try {
		const rows = await db
			.select()
			.from(assistantSenderAddresses)
			.where(eq(assistantSenderAddresses.userId, userId))
			.orderBy(assistantSenderAddresses.createdAt);
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
 * always shows the same "code sent" state regardless of which branch below ran.
 */
export async function addSenderAddress(
	env: CloudflareEnv,
	db: AppDatabase,
	userId: string,
	address: string,
): Promise<void> {
	const normalized = normalizeEmailAddress(address);
	if (!normalized) return;

	let existingCount: number;
	try {
		const rows = await db
			.select({ id: assistantSenderAddresses.id })
			.from(assistantSenderAddresses)
			.where(eq(assistantSenderAddresses.userId, userId));
		existingCount = rows.length;
	} catch (error) {
		if (isNoSuchTableError(error)) throw new SenderAddressesPendingError();
		throw error;
	}
	if (existingCount >= MAX_SENDER_ADDRESSES) return;

	const code = generateIdentityCode();
	const codeHash = await hashSessionToken(code);
	const codeExpiresAt = new Date(Date.now() + CODE_MINUTES * 60 * 1000);
	try {
		await db
			.insert(assistantSenderAddresses)
			.values({ id: newId("ases"), userId, address: normalized, codeHash, codeExpiresAt });
	} catch {
		// The unique index refused it: either this user already has it (resend the code below is skipped on
		// purpose, since re-adding an address they already added is a no-op) or it belongs to someone else — either
		// way nothing in the response may say which, so the function simply returns having sent nothing new.
		return;
	}

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
}

/** Verifies a pending address with its code; false for a wrong code, an expired one, or someone else's row. */
export async function verifySenderAddress(
	env: CloudflareEnv,
	db: AppDatabase,
	userId: string,
	id: string,
	code: string,
): Promise<boolean> {
	if (!(await allowAgentRequest(env, `assistant-email-verify:${userId}`))) return false;
	const [row] = await db
		.select()
		.from(assistantSenderAddresses)
		.where(
			and(
				eq(assistantSenderAddresses.id, id),
				eq(assistantSenderAddresses.userId, userId),
				isNull(assistantSenderAddresses.verifiedAt),
				gt(assistantSenderAddresses.codeExpiresAt, new Date()),
			),
		)
		.limit(1);
	if (!row?.codeHash || row.codeHash !== (await hashSessionToken(code))) return false;
	await db
		.update(assistantSenderAddresses)
		.set({ verifiedAt: new Date(), codeHash: null, codeExpiresAt: null })
		.where(eq(assistantSenderAddresses.id, id));
	return true;
}

/** Removes the user's own address; a no-op (not an error) for someone else's id or one already gone. */
export async function removeSenderAddress(db: AppDatabase, userId: string, id: string): Promise<void> {
	await db
		.delete(assistantSenderAddresses)
		.where(and(eq(assistantSenderAddresses.id, id), eq(assistantSenderAddresses.userId, userId)));
}
