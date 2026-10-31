import { and, eq, type SQL } from "drizzle-orm";
import { getDb } from "@/db";
import { externalAccounts } from "@/db/schema/external-accounts";
import { connectRefusal } from "./access";
import { externalAccountTablesReady } from "./errors";
import { listsIdentity, SEND_BLOCK_TEXT, sameAddress, sendBlock } from "./identity-utils";
import { findPreset } from "./presets-utils";
import { readIdentities, verifiedAddresses } from "./identity-store";
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

type OwnAccount = Awaited<ReturnType<typeof ownAccounts>>[number];

/**
 * The user's accounts matching `where`, each with why its own address cannot be sent as (null when it can) and the
 * other addresses it may send as: those whose code was entered (spec §7.2), each with the account's transport.
 */
async function ownAccounts(env: IdentityEnv, userId: string, where: SQL | undefined) {
	if (!(await externalAccountTablesReady(env))) return [];
	const rows = await getDb(env).select(identityColumns).from(externalAccounts).where(where);
	if (!rows.length) return [];
	const refusal = await connectRefusal(env, userId);
	const ids = rows.map((row) => row.id);
	const [verified, identities] = await Promise.all([readSmtpVerified(env, ids), readIdentities(env, ids)]);
	return rows.map((row) => {
		const sendable = { ...row, hasPassword: row.secret.length > 0, smtpVerifiedAt: verified.get(row.id) ?? null };
		const proven = verifiedAddresses(identities.get(row.id));
		return {
			row,
			block: sendBlock(sendable, refusal, proven.has(row.address)),
			aliases: (identities.get(row.id) ?? [])
				.filter((identity) => identity.verifiedAt && identity.address !== row.address)
				.map((identity) => ({ identity, block: sendBlock(sendable, refusal, true) })),
		};
	});
}

/** Every address an account offers: its own, then its verified aliases, each with its block. */
function addressesOf({ row, block, aliases }: OwnAccount) {
	return [
		{ address: row.address, displayName: row.displayName, block },
		...aliases.map(({ identity, block: aliasBlock }) => ({
			address: identity.address,
			displayName: identity.displayName ?? row.displayName,
			block: aliasBlock,
		})),
	];
}

const BLOCK_ACTIONS: Partial<Record<SendBlock, SendIdentity["action"]>> = {
	reconnect: "reconnect",
	not_verified: "test_connection",
	alias: "verify",
	unproven: "verify",
};

/**
 * The connected addresses the composer offers as From, by the mailbox their account delivers into (spec §7.3): the
 * current user's own accounts only, never another user's, whoever can read the mailbox. Blocked ones are listed only
 * when there is something to do about them (Reconnect, Test connection, Verify), and then cannot be chosen.
 */
export async function listSendIdentities(env: IdentityEnv, userId: string): Promise<Map<string, SendIdentity[]>> {
	const byMailbox = new Map<string, SendIdentity[]>();
	for (const account of await ownAccounts(env, userId, eq(externalAccounts.userId, userId))) {
		const { row } = account;
		for (const { address, displayName, block } of addressesOf(account)) {
			if (!listsIdentity(block)) continue;
			const list = byMailbox.get(row.mailboxId) ?? [];
			list.push({
				accountId: row.id,
				address,
				displayName,
				presetLabel: findPreset(row.preset)?.label ?? "IMAP",
				available: block === null,
				action: block ? (BLOCK_ACTIONS[block] ?? null) : null,
				hint: block ? SEND_BLOCK_TEXT[block] : null,
			});
			byMailbox.set(row.mailboxId, list);
		}
	}
	return byMailbox;
}

/** Said when a connected address is used as From anywhere but Kite's composer (spec §9.3). */
export const CONNECTED_FROM_COMPOSER_ONLY =
	"Sending as a connected account works only from Kite's composer. Open the draft there, or choose another From.";

/** Whether `address` is one of `userId`'s connected addresses (an account's own or one it verifies), whatever its state. */
export async function isOwnConnectedAddress(env: IdentityEnv, userId: string, address: string): Promise<boolean> {
	if (!(await externalAccountTablesReady(env))) return false;
	const wanted = address.trim().toLowerCase();
	const rows = await getDb(env)
		.select({ id: externalAccounts.id, address: externalAccounts.address })
		.from(externalAccounts)
		.where(eq(externalAccounts.userId, userId));
	if (rows.some((row) => row.address === wanted)) return true;
	const identities = await readIdentities(
		env,
		rows.map((row) => row.id),
	);
	return [...identities.values()].some((list) => list.some((identity) => identity.address === wanted));
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
 * that user (only the owner sends as it), delivering into that mailbox, whose own address it is or which verified it
 * with a code, and which may send now. Null when no such account exists, so the caller answers as for any address the
 * mailbox cannot send from; a blocked one throws `SendIdentityRefusedError` with what to do.
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
		and(eq(externalAccounts.userId, input.userId), eq(externalAccounts.mailboxId, input.mailboxId)),
	);
	const matches = accounts.flatMap((account) =>
		addressesOf(account)
			.filter(({ address }) => sameAddress(address, input.address))
			.map((match) => ({ ...match, row: account.row })),
	);
	if (!matches.length) return null;
	const match = matches.find(({ block }) => block === null);
	if (!match) throw new SendIdentityRefusedError(matches[0].block!);
	const preset = findPreset(match.row.preset);
	return {
		accountId: match.row.id,
		address: match.address,
		displayName: match.displayName,
		sendLimit: preset?.maxMessageBytes ? { bytes: preset.maxMessageBytes, provider: preset.label } : null,
	};
}
