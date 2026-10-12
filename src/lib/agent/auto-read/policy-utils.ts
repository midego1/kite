import type { MessageFacts } from "./facts-types";
import type { AgentActionType, ExecutionContext, ExecutionDecision, PlanInput, SenderPolicy } from "./policy-types";
import type { AutonomyLevel } from "./settings-types";
import type { PlannedSuggestion } from "./suggestion-types";

const SUGGEST_ACTIONS: readonly AgentActionType[] = ["create_draft"];
const ACT_ACTIONS: readonly AgentActionType[] = [
	...SUGGEST_ACTIONS,
	"move",
	"mark_read",
	"set_folder",
	"remind",
	"create_event",
];
const SEND_ACTIONS: readonly AgentActionType[] = ["send_rsvp", "send_reply"];

/**
 * What each level may run without a click (spec §3). Deleting events, unsubscribing and dismissing
 * are never automatic, and nothing here trashes, marks spam or forwards.
 */
const LEVEL_ACTIONS: Record<AutonomyLevel, readonly AgentActionType[]> = {
	off: [],
	suggest: SUGGEST_ACTIONS,
	act: ACT_ACTIONS,
	auto: [...ACT_ACTIONS, ...SEND_ACTIONS],
};

const LEVEL_RANK: Record<AutonomyLevel, number> = { off: 0, suggest: 1, act: 2, auto: 3 };
const SUMMARY_MIN_THREAD_MESSAGES = 3;
const SUMMARY_MIN_BODY_CHARS = 1_500;

/** Suspicious, spam, failed authentication, phishing signals or spoofing force a message down to Suggest. */
export function forcesSuggest(facts: MessageFacts, modelFlagged = false): boolean {
	return (
		modelFlagged ||
		facts.suspicious ||
		facts.spamVerdict === "spam" ||
		facts.authFailed ||
		facts.phishingSignals.length > 0 ||
		!!facts.spoofedContact
	);
}

function effectiveLevel(level: AutonomyLevel, facts: MessageFacts, modelFlagged?: boolean): AutonomyLevel {
	return LEVEL_RANK[level] > LEVEL_RANK.suggest && forcesSuggest(facts, modelFlagged) ? "suggest" : level;
}

function normalizeAddress(value: string | null | undefined): string {
	return (value ?? "").trim().toLowerCase();
}

/** Picks the policy for a sender: an exact address beats `@domain`. */
export function matchSenderPolicy<T extends Pick<SenderPolicy, "pattern">>(policies: T[], sender: string): T | null {
	const address = normalizeAddress(sender);
	const domain = address.includes("@") ? `@${address.split("@").pop()}` : null;
	return (
		policies.find((policy) => normalizeAddress(policy.pattern) === address) ??
		policies.find((policy) => domain !== null && normalizeAddress(policy.pattern) === domain) ??
		null
	);
}

function capabilityRule(action: AgentActionType, context: ExecutionContext): string | null {
	if ((action === "create_draft" || action === "send_reply") && !context.capabilities.reply)
		return "capability_reply_off";
	if ((action === "create_event" || action === "send_rsvp") && !context.capabilities.calendar)
		return "capability_calendar_off";
	return null;
}

function recipientAllowed(facts: MessageFacts, context: ExecutionContext): boolean {
	const recipient = normalizeAddress(context.recipient);
	if (!recipient) return false;
	return (
		recipient === facts.senderAddress || (!!context.organizer && recipient === normalizeAddress(context.organizer))
	);
}

function organizerIsSender(facts: MessageFacts, context: ExecutionContext): boolean {
	const organizer = normalizeAddress(context.organizer);
	return !!organizer && organizer === facts.senderAddress;
}

function rsvpRule(context: ExecutionContext): string | null {
	if (!context.rsvp) return "rsvp_missing";
	// Accept only when free and decline only when busy, so an automatic RSVP never contradicts the calendar.
	if (context.rsvp === "accepted" && context.hasConflict) return "rsvp_accept_conflict";
	if (context.rsvp === "declined" && !context.hasConflict) return "rsvp_decline_free";
	return null;
}

/** The Full auto conditions for a send (spec §3 and §7, items 2, 3 and 7). */
function sendRule(
	action: AgentActionType,
	facts: MessageFacts,
	policy: SenderPolicy | null,
	context: ExecutionContext,
): string | null {
	if (!context.fullAutoAllowed) return "full_auto_not_allowed";
	if (!policy) return "sender_not_allowlisted";
	if (!policy.allowedActions.includes(action)) return "action_not_in_sender_policy";
	if (policy.requireAuth && !facts.authPassed) return "sender_not_authenticated";
	// Spec §7.2: an invite whose organizer is not the authenticated sender never gets an automatic RSVP.
	if (action === "send_rsvp" && !organizerIsSender(facts, context)) return "organizer_not_sender";
	if (!recipientAllowed(facts, context)) return "recipient_not_sender_or_organizer";
	if ((context.threadAutoSendsLast24h ?? 0) >= 1) return "thread_send_limit";
	if (action === "send_reply") return policy.templateRule?.trim() ? null : "no_template_rule";
	return rsvpRule(context);
}

function levelRule(
	level: AutonomyLevel,
	requested: AutonomyLevel,
	action: AgentActionType,
	context: ExecutionContext,
): string | null {
	if (!LEVEL_ACTIONS[level].includes(action))
		return level !== requested && LEVEL_ACTIONS[requested].includes(action)
			? "suspicious_forces_suggest"
			: `${level}_disallows_${action}`;
	if (action === "create_event" && context.hasConflict) return "calendar_conflict";
	return null;
}

/** The single gate for agent-initiated actions. User clicks are checked against permissions instead. */
export function allowedToExecute(
	level: AutonomyLevel,
	action: AgentActionType,
	facts: MessageFacts,
	senderPolicy: SenderPolicy | null,
	context: ExecutionContext,
): ExecutionDecision {
	const effective = effectiveLevel(level, facts, context.modelFlagged);
	const block = (rule: string): ExecutionDecision => ({ allowed: false, rule, level: effective });
	if (level === "off") return block("autonomy_off");
	if (context.paused) return block("paused");
	if (context.capReached) return block("cap_reached");
	const rule =
		capabilityRule(action, context) ??
		levelRule(effective, level, action, context) ??
		(SEND_ACTIONS.includes(action) ? sendRule(action, facts, senderPolicy, context) : null);
	return rule ? block(rule) : { allowed: true, rule: `${effective}_allows_${action}`, level: effective };
}

/** Stands in for a model flag that came without a reason, so the flag still warns and blocks the reply. */
const MODEL_FLAGGED_REASON = "model_flagged";

function phishingReasons(facts: MessageFacts, triage: PlanInput["triage"]): string[] {
	const flagged = !!triage?.suspicious.flagged;
	const modelReasons = triage && flagged ? triage.suspicious.reasons : [];
	const generic = flagged && modelReasons.length === 0 ? [MODEL_FLAGGED_REASON] : [];
	return [...new Set<string>([...facts.phishingSignals, ...modelReasons, ...generic])];
}

function wantsSummary(input: PlanInput): boolean {
	const { settings, triage, facts } = input;
	if (!settings.capabilities.summary || !triage?.summary.trim()) return false;
	return settings.threadMessageCount >= SUMMARY_MIN_THREAD_MESSAGES || facts.bodyLength > SUMMARY_MIN_BODY_CHARS;
}

function wantsReply(input: PlanInput, phishing: boolean): boolean {
	const { settings, triage, facts } = input;
	return (
		!!triage?.needsReply &&
		settings.capabilities.reply &&
		settings.canDraftReply &&
		!settings.filed &&
		!phishing &&
		!facts.automatic &&
		!facts.bulk &&
		!facts.noReply
	);
}

/**
 * Turns facts and the (optional) triage result into suggestions. Model output can add phishing
 * reasons but never removes deterministic ones; a phishing suggestion suppresses the reply draft.
 */
export function planSuggestions(input: PlanInput): PlannedSuggestion[] {
	const { facts, triage, settings } = input;
	const reasons = phishingReasons(facts, triage);
	const phishing = reasons.length > 0;
	const planned: PlannedSuggestion[] = [];
	if (phishing && settings.capabilities.phishing)
		planned.push({ kind: "phishing", payload: { reasons }, reason: "phishing_signals", autoExecute: false });
	// A muted sender keeps phishing warnings but gets no other suggestions.
	if (settings.capabilities.mutedSenders.includes(facts.senderAddress)) return planned;
	planned.push(...(input.moduleSuggestions ?? []));
	if (triage && wantsSummary(input))
		planned.push({ kind: "summary", payload: { text: triage.summary }, reason: "long_thread", autoExecute: false });
	if (triage && wantsReply(input, phishing || forcesSuggest(facts)))
		planned.push({ kind: "reply", payload: { urgency: triage.urgency }, reason: "needs_reply", autoExecute: false });
	return planned;
}
