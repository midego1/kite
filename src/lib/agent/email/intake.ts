import { and, asc, count, eq, gte, isNotNull } from "drizzle-orm";
import { getDb, type AppDatabase } from "@/db";
import { domains, mailboxes, users } from "@/db/schema";
import { assistantEmailRequests, assistantSenderAddresses } from "@/db/schema/assistant-email";
import { getAutoReadInstallSettings } from "@/lib/agent/auto-read/install-settings";
import { authPassedFromSignals } from "@/lib/agent/auto-read/facts-utils";
import { allowAgentRequest } from "@/lib/agent/rate-limit";
import { readUserAiSettings } from "@/lib/agent/user-ai-settings";
import { wasForwardedByKite } from "@/lib/email/account-forwarding";
import type { InboundQueueMessage } from "@/lib/email/inbound";
import { MimeLimitError, parseRawMime } from "@/lib/email/parse";
import { parseRecipientAddress } from "@/lib/email/recipient-address";
import { findSenderMailbox, isAssistantAddressTaken, isInstallDomain } from "@/lib/email/routing";
import { newId } from "@/lib/ids";
import { analyzeAuthentication } from "@/lib/spam/analyzers/authentication";
import {
	hasAssistantLoopHeader,
	hasSingleFromAddress,
	isEmptyEnvelopeSender,
	isNonRepliableSender,
	isWithinReplayWindow,
	normalizedFromAddress,
	normalizeMessageId,
	senderHeaderNamesOther,
} from "./guards-utils";

/** A request this install will act on costs nothing beyond a Worker invocation until this point. */
const MAX_REQUEST_BYTES = 1024 * 1024;

/** The install-wide daily cap (spec §7), so a misconfigured address cannot run up cost. */
const INSTALL_DAILY_LIMIT = 500;

const MAX_SUBJECT_CHARS = 200;

function headerLookup(headers: Record<string, string> | undefined) {
	return (name: string) => headers?.[name] ?? headers?.[name.toLowerCase()] ?? null;
}

/** Midnight UTC of `now`, in seconds, for the daily counters (matches the auto-read spend caps' convention). */
function utcMidnight(now: Date): Date {
	return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

async function deleteRaw(env: CloudflareEnv, rawR2Key: string): Promise<void> {
	try {
		await env.BUCKET.delete(rawR2Key);
	} catch (error) {
		console.error(`Assistant email: failed to delete raw object ${rawR2Key}`, error);
	}
}

/**
 * The user a From address belongs to (spec §5.3): an own mailbox or alias (personal only), matched exactly —
 * dots and `+tags` kept as written, never folded the way a *receiving* address is — or a verified extra address.
 * Folding here would let anyone who can create a mailbox or alias on the owner's domain (`owner+bot@…`, `o.wner@…`)
 * have their request mapped onto the owner, since delivery folds those variants onto the same inbox.
 */
async function mapSenderToUser(
	db: AppDatabase,
	fromAddress: string,
): Promise<{ userId: string; mailboxId: string | null } | null> {
	const at = fromAddress.lastIndexOf("@");
	if (at <= 0) return null;
	const hostname = fromAddress.slice(at + 1);
	// A domain of this install, whatever its status: only an own mailbox or alias counts on it, never a verified
	// extra address (addSenderAddress already refuses to verify one there) — a defence against a stale or
	// otherwise-created row, on top of refusing it at the source (security review).
	if (await isInstallDomain(db, hostname)) {
		const [domain] = await db
			.select({ id: domains.id })
			.from(domains)
			.where(and(eq(domains.hostname, hostname), eq(domains.status, "active")))
			.limit(1);
		if (!domain) return null;
		const mailbox = await findSenderMailbox(db, domain.id, hostname, fromAddress);
		return mailbox ? { userId: mailbox.userId, mailboxId: mailbox.mailboxId } : null;
	}
	// A verified extra address; unverified or expired rows never map, so a user who only started verifying one
	// does not get the mailbox of a request they never sent.
	const [verified] = await db
		.select({ userId: assistantSenderAddresses.userId })
		.from(assistantSenderAddresses)
		.where(and(eq(assistantSenderAddresses.address, fromAddress), isNotNull(assistantSenderAddresses.verifiedAt)))
		.limit(1);
	return verified ? { userId: verified.userId, mailboxId: null } : null;
}

/** The mailbox a request from a verified extra address runs in: the user's choice, else their first personal mailbox. */
async function defaultContextMailboxId(db: AppDatabase, userId: string): Promise<string | null> {
	const settings = await readUserAiSettings(db, userId);
	if (settings.assistantEmail.mailboxId) return settings.assistantEmail.mailboxId;
	const [mailbox] = await db
		.select({ id: mailboxes.id })
		.from(mailboxes)
		.where(and(eq(mailboxes.userId, userId), eq(mailboxes.type, "personal"), eq(mailboxes.disabled, false)))
		.orderBy(asc(mailboxes.createdAt))
		.limit(1);
	return mailbox?.id ?? null;
}

async function requestsToday(db: AppDatabase, now: Date, userId?: string): Promise<number> {
	const where = userId
		? and(eq(assistantEmailRequests.userId, userId), gte(assistantEmailRequests.createdAt, utcMidnight(now)))
		: gte(assistantEmailRequests.createdAt, utcMidnight(now));
	const [row] = await db.select({ n: count() }).from(assistantEmailRequests).where(where);
	return row?.n ?? 0;
}

type ParsedMail = Awaited<ReturnType<typeof parseRawMime>>;

/**
 * Size, MIME parsing, every loop/auto-reply/sender guard of §6, authentication (§5.2) and the replay window
 * (§7): everything that only needs the raw bytes and the queue payload, with no sense yet of which user (if
 * any) the request belongs to. Null means "drop silently"; the raw object is not touched here.
 */
async function parseAndGuard(
	env: CloudflareEnv,
	db: AppDatabase,
	payload: InboundQueueMessage,
): Promise<{ parsed: ParsedMail; fromAddress: string } | null> {
	if (isEmptyEnvelopeSender(payload.from)) return null;

	const object = await env.BUCKET.get(payload.rawR2Key);
	if (!object) return null; // Nothing to clean up; the object is already gone.
	const raw = await object.arrayBuffer();
	if (raw.byteLength > MAX_REQUEST_BYTES) return null;

	let parsed: ParsedMail;
	try {
		parsed = await parseRawMime(raw);
	} catch (error) {
		if (error instanceof MimeLimitError) return null;
		throw error;
	}

	const header = headerLookup(payload.headers);
	if (hasAssistantLoopHeader(payload.from, payload.headers)) return null;
	if (await wasForwardedByKite(env, header)) return null;
	if (!hasSingleFromAddress(header("from"))) return null;

	const fromAddress = normalizedFromAddress(parsed.fromAddr ?? payload.from);
	if (isNonRepliableSender(fromAddress)) return null;
	if (senderHeaderNamesOther(header("sender"), fromAddress)) return null;
	const fromParsed = parseRecipientAddress(fromAddress);
	if (fromParsed && (await isFromAnAssistantAddress(db, fromParsed))) return null;

	// Section 5.2: the trusted Authentication-Results the intake hop vouched for, never the message's own headers.
	const signals = analyzeAuthentication(payload.authenticationResults, fromParsed?.domain ?? "");
	if (!authPassedFromSignals(signals)) return null;

	if (!isWithinReplayWindow(parsed.date, new Date())) return null;

	return { parsed, fromAddress };
}

/**
 * The earlier request this one follows up on (spec §8.5): a prior accepted request from the same user whose own
 * reply's Message-ID this one's `In-Reply-To` names. Null for a fresh request. Checked after sender mapping, so
 * only the owner's own `In-Reply-To` can continue their conversation, never anyone else's.
 */
async function findFollowUpParent(
	db: AppDatabase,
	userId: string,
	inReplyTo: string | null,
): Promise<{ conversationId: string; mailboxId: string } | null> {
	if (!inReplyTo) return null;
	const [parent] = await db
		.select({ conversationId: assistantEmailRequests.conversationId, mailboxId: assistantEmailRequests.mailboxId })
		.from(assistantEmailRequests)
		.where(and(eq(assistantEmailRequests.userId, userId), eq(assistantEmailRequests.replyMessageId, inReplyTo)))
		.limit(1);
	return parent?.conversationId && parent.mailboxId
		? { conversationId: parent.conversationId, mailboxId: parent.mailboxId }
		: null;
}

/** Whether `address` is itself an assistant address of this install (never answered, to avoid a reply loop). */
async function isFromAnAssistantAddress(
	db: AppDatabase,
	address: { domain: string; localPart: string },
): Promise<boolean> {
	const [fromDomain] = await db
		.select({ id: domains.id })
		.from(domains)
		.where(eq(domains.hostname, address.domain))
		.limit(1);
	return !!fromDomain && (await isAssistantAddressTaken(db, fromDomain.id, address.localPart));
}

/** The active user and install state a request needs (§5.3, §7); null means "drop silently". */
async function authorizeSender(
	env: CloudflareEnv,
	db: AppDatabase,
	fromAddress: string,
): Promise<{ userId: string; mailboxId: string | null; dailyLimit: number } | null> {
	const mapped = await mapSenderToUser(db, fromAddress);
	if (!mapped) return null;

	const [user] = await db
		.select({ id: users.id, disabled: users.disabled })
		.from(users)
		.where(eq(users.id, mapped.userId))
		.limit(1);
	if (!user || user.disabled) return null;

	const install = await getAutoReadInstallSettings(env);
	if (!install.agentEnabled) return null;

	const aiSettings = await readUserAiSettings(db, user.id);
	if (!aiSettings.assistantEmail.enabled) return null;

	return { userId: user.id, mailboxId: mapped.mailboxId, dailyLimit: aiSettings.assistantEmail.dailyLimit };
}

/** Burst and daily limits (§7); true means within them. */
async function withinLimits(env: CloudflareEnv, db: AppDatabase, userId: string, dailyLimit: number): Promise<boolean> {
	if (!(await allowAgentRequest(env, `assistant-email:${userId}`))) return false;
	const now = new Date();
	if ((await requestsToday(db, now, userId)) >= dailyLimit) return false;
	return (await requestsToday(db, now)) < INSTALL_DAILY_LIMIT;
}

/**
 * Accepts or drops a request to an assistant address (docs/specs/assistant-by-email.md §4, §5, §6, §7). Owns the
 * raw R2 object from here: every "drop silently" path deletes it without creating a row or making a model call.
 * A request that passes every check is inserted as `queued` and handed to `processAssistantEmailRequest`
 * (`process.ts`), which runs the model and sends the reply, including the "could not answer" reply a limit this
 * function enforces does not send itself (it has no conversation yet to point that reply at).
 */
export async function acceptAssistantRequest(
	env: CloudflareEnv,
	payload: InboundQueueMessage,
	assistantAddressId: string | undefined,
): Promise<void> {
	const db = getDb(env);
	const drop = () => deleteRaw(env, payload.rawR2Key);

	const guarded = await parseAndGuard(env, db, payload);
	if (!guarded) return drop();
	const { parsed, fromAddress } = guarded;

	const authorized = await authorizeSender(env, db, fromAddress);
	if (!authorized) return drop();
	if (!(await withinLimits(env, db, authorized.userId, authorized.dailyLimit))) return drop();

	const messageId = normalizeMessageId(parsed.messageId);
	if (!messageId) return drop();

	// A follow-up's quoted earlier answer carries the parent's mailbox and continues its conversation (§8.5); every
	// other check above still applies to it, same as a fresh request.
	const followUp = await findFollowUpParent(db, authorized.userId, normalizeMessageId(parsed.inReplyTo));
	const mailboxId =
		followUp?.mailboxId ?? authorized.mailboxId ?? (await defaultContextMailboxId(db, authorized.userId));
	if (!mailboxId) return drop();

	const requestId = newId("aer");
	const inserted = await db
		.insert(assistantEmailRequests)
		.values({
			id: requestId,
			userId: authorized.userId,
			assistantAddressId: assistantAddressId ?? null,
			mailboxId,
			conversationId: followUp?.conversationId ?? null,
			rawR2Key: payload.rawR2Key,
			providerMessageId: messageId,
			fromAddr: fromAddress,
			subject: parsed.subject?.slice(0, MAX_SUBJECT_CHARS) ?? null,
			status: "queued",
		})
		.onConflictDoNothing()
		.returning({ id: assistantEmailRequests.id });
	if (inserted.length === 0) return drop(); // Section 7: the same Message-ID was already seen for this user.

	await env.AGENT_QUEUE?.send({ kind: "agent.assistant_email", requestId });
}
