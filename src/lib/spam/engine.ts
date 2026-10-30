import { and, eq } from "drizzle-orm";
import type { AppDatabase } from "@/db";
import { contacts, spamReputation } from "@/db/schema";
import { getEmailAddress } from "@/lib/email/address";
import { analyzeAttachments } from "./analyzers/attachments";
import { analyzeAuthentication } from "./analyzers/authentication";
import { analyzeSafelistPressure } from "./analyzers/pressure";
import { getReputationKeys } from "./analyzers/reputation";
import { analyzeStructure } from "./analyzers/structure";
import { analyzeUrls } from "./analyzers/urls";
import { classifyTokens } from "./classifier";
import { buildFingerprint, getDomain, prepareSpamContent, tokenizeMessage } from "./tokenizer";
import { fromMayBeForged, planAuthPolicy, publishedDmarcPolicy, type AuthPolicyDecision } from "./dmarc-policy-utils";
import type { DmarcPolicy, PreparedSpamContent, SpamAnalysisInput, SpamAnalysisResult, SpamSignal } from "./types";
import { SPAM_THRESHOLDS, SPAM_WEIGHTS } from "./weights";
import { LocalSpamIntelligenceProvider } from "./providers/local";

export async function analyzeSpam(db: AppDatabase, input: SpamAnalysisInput): Promise<SpamAnalysisResult> {
	const prepared = prepareSpamContent(input.message);
	const fingerprint = buildFingerprint(input.message, prepared);
	const sender = getEmailAddress(input.message.fromAddr ?? input.envelopeFrom).toLowerCase();
	const fromDomain = getDomain(input.message.fromAddr);
	const authentication = analyzeAuthentication(input.authenticationResults, fromDomain);
	const signals: SpamSignal[] = [
		...authentication,
		...analyzeUrls(input.message, prepared),
		...analyzeStructure(input.message, input.headers, prepared),
		...analyzeAttachments(input.message, prepared),
		...analyzeSafelistPressure(prepared),
	];
	const [contact] = sender
		? await db
				.select()
				.from(contacts)
				.where(and(eq(contacts.userId, input.userId), eq(contacts.email, sender)))
				.limit(1)
		: [];
	if (contact?.blocked) {
		return {
			score: 100,
			verdict: "spam",
			signals: [{ id: "blocked_sender", score: 100, reason: "Sender is blocked" }],
			fingerprint,
		};
	}
	const authIds = new Set(authentication.map((signal) => signal.id));
	const mayBeForged = fromMayBeForged(authIds);
	signals.push(
		...(await intelligenceSignals(input, contact?.source, signals, { sender, prepared, fingerprint, mayBeForged })),
	);
	// A known contact's trust must not offset a From that may be forged: a spoofed colleague is the attack.
	if (!mayBeForged) signals.push(...relationshipSignals(contact?.source));
	const authPolicy = await enforcedAuthPolicy(input, authIds, fromDomain);

	const identities = getReputationKeys(input.message, fingerprint);
	const reputationRecords = await Promise.all(
		identities.map(async (identity) => {
			const [record] = await db
				.select()
				.from(spamReputation)
				.where(
					and(
						eq(spamReputation.mailboxId, input.mailboxId),
						eq(spamReputation.type, identity.type),
						eq(spamReputation.key, identity.key),
					),
				)
				.limit(1);
			return { identity, record };
		}),
	);
	const reputationSignals: SpamSignal[] = [];
	for (const { identity, record } of reputationRecords) {
		if (!record || record.spamCount + record.hamCount < 3) continue;
		const spamRatio = (record.spamCount + 1) / (record.spamCount + record.hamCount + 2);
		if (spamRatio >= 0.8)
			reputationSignals.push({
				id: `poor_${identity.type}_reputation`,
				score: SPAM_WEIGHTS.reputation.establishedSpam,
				reason: `${identity.type === "fingerprint" ? "Similar messages have" : "This sender has"} repeatedly been marked as spam`,
			});
		if (spamRatio <= 0.2)
			reputationSignals.push({
				id: `good_${identity.type}_reputation`,
				score: SPAM_WEIGHTS.reputation.establishedHam,
				reason: `${identity.type === "fingerprint" ? "Similar messages have" : "This sender has"} repeatedly been marked as legitimate`,
			});
	}
	const strongestReputation = reputationSignals.sort((a, b) => Math.abs(b.score) - Math.abs(a.score))[0];
	if (strongestReputation) signals.push(strongestReputation);

	const bayesian = await classifyTokens(db, input.mailboxId, tokenizeMessage(input.message, prepared));
	if (bayesian.contribution !== 0)
		signals.push({
			id: bayesian.contribution > 0 ? "bayesian_spam" : "bayesian_ham",
			score: bayesian.contribution,
			reason:
				bayesian.contribution > 0
					? "Content resembles messages previously marked as spam"
					: "Content resembles messages previously marked as legitimate",
			metadata: { probability: Number(bayesian.probability.toFixed(3)), trainedMessages: bayesian.trainedMessages },
		});

	// Always recorded when it applies, so a spam verdict carries its reason: the exact lift to the spam threshold,
	// or 0 when the score was already there, so the signals still add up to the score.
	const scoreBeforePolicy = signals.reduce((total, signal) => total + signal.score, 0);
	if (authPolicy)
		signals.push({
			id: "auth_policy",
			score: Math.max(0, SPAM_THRESHOLDS.spam - scoreBeforePolicy),
			reason: `${authPolicy.reason}; filed as spam`,
			metadata: { cause: authPolicy.cause },
		});

	const rawScore = signals.reduce((total, signal) => total + signal.score, 0);
	const score = Math.max(0, Math.min(100, rawScore));
	if (rawScore !== score)
		signals.push({
			id: "score_boundary",
			score: score - rawScore,
			reason: rawScore > 100 ? "Score is capped at 100" : "Score cannot be lower than 0",
		});
	const verdict = score >= SPAM_THRESHOLDS.spam ? "spam" : score >= SPAM_THRESHOLDS.suspicious ? "suspicious" : "inbox";
	return {
		score,
		verdict,
		signals: signals.filter((signal) => Math.abs(signal.score) >= 2 || ALWAYS_KEPT.has(signal.id)),
		contentProbability: bayesian.probability,
		fingerprint,
	};
}

/** Signals kept whatever their score, because the score they explain depends on them. */
const ALWAYS_KEPT = new Set(["score_boundary", "auth_policy"]);

type ContactSource = string | null | undefined;

async function intelligenceSignals(
	input: SpamAnalysisInput,
	source: ContactSource,
	localSignals: readonly SpamSignal[],
	content: { sender: string; prepared: PreparedSpamContent; fingerprint: string; mayBeForged: boolean },
): Promise<SpamSignal[]> {
	// Nothing about a known correspondent's mail leaves Kite, unless authentication failed and the From may be forged.
	const knownCorrespondent = source === "manual" || source === "outbound";
	if (knownCorrespondent && !content.mayBeForged) return [];
	const provider = input.intelligenceProvider ?? new LocalSpamIntelligenceProvider();
	return provider.check({
		senderDomain: getDomain(content.sender),
		urlDomains: content.prepared.urlDomains,
		fingerprint: content.fingerprint,
		urls: content.prepared.urls,
		attachmentUrls: content.prepared.attachmentUrls,
		attachments: input.message.attachments,
		localSignals: [...localSignals],
	});
}

/**
 * Whether failed authentication files this message as spam (`planAuthPolicy`). The published policy comes from the
 * trusted `Authentication-Results` when it names one, else from DNS; both are read only when DMARC failed, and a
 * lookup that cannot answer counts as `unknown`, which enforces nothing.
 */
async function enforcedAuthPolicy(
	input: SpamAnalysisInput,
	ids: ReadonlySet<string>,
	fromDomain: string,
): Promise<AuthPolicyDecision | null> {
	if (!ids.has("dmarc_failed")) return planAuthPolicy(ids, { policy: "unknown", strict: false });
	const reported = publishedDmarcPolicy(input.authenticationResults);
	if (reported === "reject" || reported === "quarantine")
		return planAuthPolicy(ids, { policy: reported, strict: false });
	const source = input.dmarcPolicy;
	if (source && (await source.strict().catch(() => false)))
		return planAuthPolicy(ids, { policy: reported ?? "unknown", strict: true });
	const policy: DmarcPolicy =
		reported ??
		(source && fromDomain ? await source.published(fromDomain).catch((): DmarcPolicy => "unknown") : "unknown");
	return planAuthPolicy(ids, { policy, strict: false });
}

function relationshipSignals(source: ContactSource): SpamSignal[] {
	if (source === "manual")
		return [
			{
				id: "manual_contact",
				score: SPAM_WEIGHTS.relationships.manuallySavedContact,
				reason: "Sender is in your manually saved contacts",
			},
		];
	if (source === "outbound")
		return [
			{
				id: "previously_sent",
				score: SPAM_WEIGHTS.relationships.previouslySentTo,
				reason: "You have previously sent email to this address",
			},
		];
	return [];
}
