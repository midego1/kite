import { recordConnectionTest, auditExternalAccount } from "./audit";
import { ExternalAccountRefusal } from "./errors";
import type { ExternalAccountRow } from "./serialize-utils";
import { assertAllowed, ownAccount, type AccountActor } from "./service";
import { withAccountSession } from "./sync";
import {
	countPendingActions,
	readRecentProblems,
	readSupport,
	readTwoWayConfig,
	saveSupport,
	saveTwoWaySettings,
	twoWayReady,
} from "./two-way-store";
import type { ProviderSupport, TwoWaySettings, TwoWayView } from "./two-way-types";
import {
	parseTwoWayInput,
	planProviderSupport,
	RECONCILE_WINDOW,
	SUPPORT_MAX_AGE_MS,
	twoWaySupportProblem,
} from "./two-way-utils";

const PROBLEMS_SHOWN = 5;

/**
 * Asks the account's server what it supports, for the settings: a short read-only session under the sync lease, limited
 * like a connection test. Null when it cannot be asked (no password, a paused, suspended or failing account, a check
 * running right now, a server that does not answer); a choice that needs the answer is then refused rather than guessed.
 */
async function askServer(env: CloudflareEnv, account: ExternalAccountRow, now: Date): Promise<ProviderSupport | null> {
	try {
		await recordConnectionTest(env, account.userId, {
			host: account.imapHost,
			port: account.imapPort,
			preset: account.preset,
			accountId: account.id,
		});
		return await withAccountSession(env, account.id, {}, async (session) => {
			const support = planProviderSupport(session.capabilities, await session.listMailboxes(), now);
			await saveSupport(env, account.id, support);
			return support;
		});
	} catch {
		return null;
	}
}

/** The stored answers while they are fresh, else the server's own; the stored ones when it cannot be asked. */
async function currentSupport(env: CloudflareEnv, account: ExternalAccountRow, stored: ProviderSupport | null) {
	const now = new Date();
	if (stored && now.getTime() - new Date(stored.checkedAt).getTime() < SUPPORT_MAX_AGE_MS) return stored;
	return (await askServer(env, account, now)) ?? stored;
}

async function ownReadyAccount(env: CloudflareEnv, actor: AccountActor, id: string) {
	const account = await ownAccount(env, actor.id, id);
	if (!(await twoWayReady(env)))
		throw new ExternalAccountRefusal(409, "Apply the pending database update to use two-way sync", "MIGRATION_PENDING");
	return account;
}

/** The account's two-way settings for its owner; another user's account answers like a missing one. */
export async function readTwoWayView(env: CloudflareEnv, actor: AccountActor, id: string): Promise<TwoWayView> {
	const account = await ownReadyAccount(env, actor, id);
	const { settings, state } = await readTwoWayConfig(env, id);
	const [support, pending, problems] = await Promise.all([
		currentSupport(env, account, readSupport(state)),
		countPendingActions(env, id),
		readRecentProblems(env, id, PROBLEMS_SHOWN),
	]);
	return { settings, support, pending, problems, windowSize: RECONCILE_WINDOW };
}

/**
 * Saves the account's two-way settings, owner only. A choice this server cannot carry out is refused. From this
 * moment the settings apply: to Kite actions made from now on, and at the provider to what changes from the next
 * check on. An action already waiting whose setting was turned off is dropped.
 */
export async function saveTwoWay(
	env: CloudflareEnv,
	actor: AccountActor,
	id: string,
	body: Record<string, unknown>,
): Promise<TwoWayView> {
	const account = await ownReadyAccount(env, actor, id);
	await assertAllowed(env, actor.id);
	const settings: TwoWaySettings | null = parseTwoWayInput(body);
	if (!settings) throw new ExternalAccountRefusal(400, "Choose a valid option for each setting");
	const before = await readTwoWayConfig(env, id);
	const support = await currentSupport(env, account, readSupport(before.state));
	const problem = twoWaySupportProblem(settings, support);
	if (problem) throw new ExternalAccountRefusal(409, problem, "NOT_SUPPORTED");
	await saveTwoWaySettings(env, id, before.settings, settings);
	await auditExternalAccount(env, {
		actorUserId: actor.id,
		action: "external_account.two_way_changed",
		mailboxId: account.mailboxId,
		metadata: { accountId: id, ...settings },
	});
	return readTwoWayView(env, actor, id);
}
