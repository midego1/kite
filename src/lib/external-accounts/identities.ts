import { and, eq, type SQL } from "drizzle-orm";
import { getDb } from "@/db";
import { externalAccounts } from "@/db/schema/external-accounts";
import { connectRefusal } from "./access";
import { externalAccountTablesReady } from "./errors";
import { listsIdentity, SEND_BLOCK_TEXT, sameAddress, sendBlock } from "./identity-utils";
import { findPreset } from "./presets-utils";
import { readSmtpVerified } from "./send-state";
import type { SendBlock, SendIdentity } from "./types";

type IdentityEnv = Pick<CloudflareEnv, "DB" | "APP_ENCRYPTION_KEY">;

const identityColumns = {
	id: externalAccounts.id,
	userId: externalAccounts.userId,
	mailboxId: externalAccounts.mailboxId,
	address: externalAccounts.address,
	username: externalAccounts.username,
	displayName: externalAccounts.displayName,
	preset: externalAccounts.preset,
	status: externalAccounts.status,
	smtpHost: externalAccounts.smtpHost,
	sendEnabled: externalAccounts.sendEnabled,
	secret: externalAccounts.secret,
};

async function ownAccounts(env: IdentityEnv, userId: string, where: SQL | undefined) {
	if (!(await externalAccountTablesReady(env))) return [];
	const rows = await getDb(env).select(identityColumns).from(externalAccounts).where(where);
	if (!rows.length) return [];
	const refusal = await connectRefusal(env, userId);
	const verified = await readSmtpVerified(
		env,
		rows.map((row) => row.id),
	);
	return rows.map((row) => ({
		row,
		block: sendBlock(
			{ ...row, hasPassword: row.secret.length > 0, smtpVerifiedAt: verified.get(row.id) ?? null },
			refusal,
		),
	}));
}

/**
 * The connected addresses the composer offers as From, by the mailbox their account delivers into (spec §7.3): the
 * current user's own accounts only, never another user's, whoever can read the mailbox. Blocked ones are listed only
 * when there is something to do about them (Reconnect, Test connection), and then cannot be chosen.
 */
export async function listSendIdentities(env: IdentityEnv, userId: string): Promise<Map<string, SendIdentity[]>> {
	const byMailbox = new Map<string, SendIdentity[]>();
	for (const { row, block } of await ownAccounts(env, userId, eq(externalAccounts.userId, userId))) {
		if (!listsIdentity(block)) continue;
		const list = byMailbox.get(row.mailboxId) ?? [];
		list.push({
			accountId: row.id,
			address: row.address,
			displayName: row.displayName,
			presetLabel: findPreset(row.preset)?.label ?? "IMAP",
			available: block === null,
			action: block === "reconnect" ? "reconnect" : block === "not_verified" ? "test_connection" : null,
			hint: block ? SEND_BLOCK_TEXT[block] : null,
		});
		byMailbox.set(row.mailboxId, list);
	}
	return byMailbox;
}

/** Said when a connected address is used as From anywhere but Kite's composer (spec §9.3). */
export const CONNECTED_FROM_COMPOSER_ONLY =
	"Sending as a connected account works only from Kite's composer. Open the draft there, or choose another From.";

/** Whether `address` is one of `userId`'s connected accounts, whatever its state. */
export async function isOwnConnectedAddress(env: IdentityEnv, userId: string, address: string): Promise<boolean> {
	if (!(await externalAccountTablesReady(env))) return false;
	const [row] = await getDb(env)
		.select({ id: externalAccounts.id })
		.from(externalAccounts)
		.where(and(eq(externalAccounts.userId, userId), eq(externalAccounts.address, address.trim().toLowerCase())))
		.limit(1);
	return !!row;
}

/** A From that is a connected address of the sender but cannot be used now, with the reason. */
class SendIdentityRefusedError extends Error {
	constructor(readonly block: SendBlock) {
		super(`You cannot send from this address right now. ${SEND_BLOCK_TEXT[block]}`);
		this.name = "SendIdentityRefusedError";
	}
}

/**
 * The account to send `address` through for `userId` from `mailboxId` (spec §7.3 "Authorization"): an account of
 * that user (only the owner sends as it), delivering into that mailbox, whose address it is and which may send now.
 * Null when no such account exists, so the caller answers as for any address the mailbox cannot send from; a blocked
 * account throws `SendIdentityRefusedError` with what to do.
 */
export async function resolveSendIdentity(
	env: IdentityEnv,
	input: { userId: string; mailboxId: string; address: string },
): Promise<{
	accountId: string;
	address: string;
	displayName: string | null;
	sendLimit: { bytes: number; provider: string } | null;
} | null> {
	const accounts = await ownAccounts(
		env,
		input.userId,
		and(
			eq(externalAccounts.userId, input.userId),
			eq(externalAccounts.mailboxId, input.mailboxId),
			eq(externalAccounts.address, input.address.trim().toLowerCase()),
		),
	);
	const match = accounts.find(({ row }) => sameAddress(row.address, input.address));
	if (!match) return null;
	if (match.block) throw new SendIdentityRefusedError(match.block);
	const preset = findPreset(match.row.preset);
	return {
		accountId: match.row.id,
		address: match.row.address,
		displayName: match.row.displayName,
		sendLimit: preset?.maxMessageBytes ? { bytes: preset.maxMessageBytes, provider: preset.label } : null,
	};
}
