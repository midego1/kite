import type { ReputationKey, SpamClassification } from "./types";
import { PHISHING_FINGERPRINT_WEIGHT } from "./weights";

/**
 * The statements that add (`direction` 1) or take back (-1) one message's training for `target`: a count
 * per token and per reputation key, never below zero. A phishing report weighs the fingerprint
 * `PHISHING_FINGERPRINT_WEIGHT` times; taking it back subtracts the same weight.
 */
export function trainingStatements(
	env: CloudflareEnv,
	mailboxId: string,
	tokens: readonly string[],
	keys: readonly ReputationKey[],
	target: SpamClassification,
	direction: 1 | -1,
	now: number,
): D1PreparedStatement[] {
	const statements: D1PreparedStatement[] = [];
	const spam = target !== "ham";
	for (const token of tokens)
		statements.push(
			env.DB.prepare(
				`INSERT INTO spam_token_stats (mailbox_id, token, spam_count, ham_count, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(mailbox_id, token) DO UPDATE SET spam_count = MAX(0, spam_count + excluded.spam_count), ham_count = MAX(0, ham_count + excluded.ham_count), updated_at = excluded.updated_at`,
			).bind(mailboxId, token, spam ? direction : 0, spam ? 0 : direction, now),
		);
	for (const item of keys) {
		const weight = target === "phishing" && item.type === "fingerprint" ? PHISHING_FINGERPRINT_WEIGHT : 1;
		const amount = direction * weight;
		statements.push(
			env.DB.prepare(
				`INSERT INTO spam_reputation (mailbox_id, type, key, messages_seen, spam_count, ham_count, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(mailbox_id, type, key) DO UPDATE SET messages_seen = MAX(messages_seen, excluded.messages_seen), spam_count = MAX(0, spam_count + excluded.spam_count), ham_count = MAX(0, ham_count + excluded.ham_count), last_seen_at = excluded.last_seen_at`,
			).bind(mailboxId, item.type, item.key, amount > 0 ? 1 : 0, spam ? amount : 0, spam ? 0 : amount, now, now),
		);
	}
	return statements;
}
