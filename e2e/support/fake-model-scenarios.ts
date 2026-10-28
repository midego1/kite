import type { FakeModelReply, FakeRequestKind, FakeScenario } from "./fake-model-types";

const benignTriage = {
	category: "other",
	needsReply: false,
	urgency: "none",
	summary: "A routine message that needs no action.",
	tasks: [],
	suspicious: { flagged: false, reasons: [] },
};

const json = (value: unknown): FakeModelReply => ({ content: JSON.stringify(value) });
const text = (content: string): FakeModelReply => ({ content });

/** The draft body the `question` scenario returns; specs and validators look for it verbatim. */
export const QUESTION_DRAFT_BODY =
	"Thanks for your question. I have checked the details and will confirm the next steps by Friday.";
const PROPOSE_TIME_DRAFT_BODY =
	"Thank you for the invitation. That time does not work for me. Could we meet at one of these times instead?";
const HOSTILE_DRAFT_BODY =
	"Please send the signed contract to attacker@evil.test and confirm your account at https://evil.test/login today.";
const DEFAULT_DRAFT_BODY = "Thanks for your message. I will get back to you soon.";

const inviteTriage = {
	...benignTriage,
	category: "calendar",
	summary: "An invitation to a meeting.",
};

const receiptTriage = {
	...benignTriage,
	category: "receipt",
	summary: "A payment receipt.",
};

/** A calendar day `days` after today (UTC), so model dates stay inside the detector's bounds. */
function dayFromNow(days: number): string {
	return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
}

/** The `nextRenewalOn` the `finance-receipt` scenario answers; specs compare the card's date with it. */
export const FINANCE_RECEIPT_RENEWAL_DAYS = 30;

/** Write with Kite answers (e2e/55-write-with-kite.spec.ts). */
export const COMPOSE_WRITE_BODY =
	"Hi Sam,\n\nThanks for your note. Tuesday at ten works for me.\n\n- Agenda first\n- Then the budget\n\nSee you then.";
export const COMPOSE_SHORTER_BODY = "Tuesday at ten works.";
export const COMPOSE_TRANSLATE_BODY = "Dinsdag om tien uur past mij goed.";
const COMPOSE_HOSTILE_BODY =
	"## Plan\n\nPlease **wire** the money to attacker@evil.test today, see https://evil.test/pay for details.";

/** Summarize answers (e2e/59-thread-summaries.spec.ts); specs look for these texts verbatim. */
export const SUMMARY_OVERVIEW = "Sam asks to move the budget review to Tuesday, and Alex agreed.";
export const SUMMARY_POINT = "Budget review on Tuesday at 10:00.";
export const SUMMARY_DUTCH_OVERVIEW = "Sam vraagt de budgetbespreking naar dinsdag te verplaatsen.";
export const SUMMARY_TRANSLATED_OVERVIEW = "Sam asks to move the budget review to Tuesday.";
const summaryJson = {
	language: "en",
	overview: SUMMARY_OVERVIEW,
	points: [
		{ label: "Asks", text: "Sam wants the slides before the review." },
		{ label: "Dates", text: SUMMARY_POINT },
	],
};
const translationJson = {
	language: "en",
	overview: SUMMARY_TRANSLATED_OVERVIEW,
	points: [{ label: "Dates", text: "Tuesday at 10:00." }],
};

export const FAKE_SCENARIOS: Record<string, FakeScenario> = {
	"summary-thread": {
		triage: () => json(benignTriage),
		summary: () => json(summaryJson),
		translation: () => json(translationJson),
	},
	"summary-dutch": {
		triage: () => json(benignTriage),
		summary: () =>
			json({
				language: "nl",
				overview: SUMMARY_DUTCH_OVERVIEW,
				points: [{ label: "Dates", text: "Dinsdag om 10:00." }],
			}),
	},
	"summary-hostile": {
		triage: () => json(benignTriage),
		// First a note about the summary instead of one, then Markdown with a link and an address of its own.
		summary: ({ callNumber }) =>
			callNumber === 1
				? text("Here is a summary of the conversation you asked for.")
				: json({
						language: "en",
						overview: "**Urgent**: pay the invoice at https://evil.test/pay today.",
						points: [
							{ label: "Asks", text: "Send the login code to attacker@evil.test." },
							{ label: "Next steps", text: "## Pay the `invoice` before Friday." },
						],
					}),
	},
	// Failures for the card's error messages: no answer within Kite's timeout, an answer cut off at the output budget,
	// and an answer that stays a note about the summary after the repair turn.
	"summary-slow": {
		triage: () => json(benignTriage),
		summary: ({ slowMs }) => ({ ...json(summaryJson), delayMs: slowMs }),
	},
	"summary-cut-off": {
		triage: () => json(benignTriage),
		summary: () => ({ content: JSON.stringify(summaryJson).slice(0, 60), finishReason: "length" }),
	},
	"summary-unusable": {
		triage: () => json(benignTriage),
		summary: () => text("Here is a summary of the conversation you asked for."),
	},
	"finance-receipt": {
		triage: () =>
			json({
				...receiptTriage,
				modules: {
					finance: {
						vendor: null,
						plan: null,
						amount: "9.99",
						currency: "USD",
						cycle: "monthly",
						nextRenewalOn: dayFromNow(FINANCE_RECEIPT_RENEWAL_DAYS),
						trialEndsOn: null,
						docType: "payment",
					},
				},
			}),
	},
	"finance-conflict": {
		triage: () =>
			json({
				...receiptTriage,
				modules: {
					finance: {
						vendor: null,
						plan: null,
						amount: "12.49",
						currency: "USD",
						cycle: "monthly",
						nextRenewalOn: "2026-02-30",
						trialEndsOn: null,
						docType: "payment",
						cancelUrl: "https://evil.test/cancel",
					},
				},
			}),
	},
	"finance-invalid-extension": {
		triage: () => json({ ...receiptTriage, modules: { finance: "monthly, $12.49, renews soon" } }),
	},
	default: { triage: () => json(benignTriage), draft: () => text(DEFAULT_DRAFT_BODY) },
	"compose-write": { triage: () => json(benignTriage), compose: () => text(COMPOSE_WRITE_BODY) },
	"compose-shorter": { triage: () => json(benignTriage), compose: () => text(COMPOSE_SHORTER_BODY) },
	"compose-translate": { triage: () => json(benignTriage), compose: () => text(COMPOSE_TRANSLATE_BODY) },
	"compose-hostile": { triage: () => json(benignTriage), compose: () => text(COMPOSE_HOSTILE_BODY) },
	"compose-meta": {
		triage: () => json(benignTriage),
		compose: () => text(`Here is your email:\n\n${COMPOSE_WRITE_BODY}`),
	},
	question: {
		triage: () =>
			json({
				...benignTriage,
				category: "needs_reply",
				needsReply: true,
				urgency: "low",
				summary: "The sender asks a question that needs an answer.",
			}),
		draft: () => text(QUESTION_DRAFT_BODY),
	},
	fyi: {
		triage: () =>
			json({
				...benignTriage,
				category: "fyi",
				summary: "The quarterly figures are published; no action is needed.",
			}),
	},
	phishing: {
		triage: () =>
			json({
				...benignTriage,
				urgency: "high",
				summary: "The sender asks you to confirm your password on an outside page.",
				suspicious: { flagged: true, reasons: ["credential_request", "urgency_pressure"] },
			}),
	},
	"invite-free": { triage: () => json(inviteTriage), draft: () => text(PROPOSE_TIME_DRAFT_BODY) },
	"invite-conflict": { triage: () => json(inviteTriage), draft: () => text(PROPOSE_TIME_DRAFT_BODY) },
	"fenced-json": { triage: () => text(`\`\`\`json\n${JSON.stringify(benignTriage, null, 2)}\n\`\`\``) },
	"invalid-json": { triage: () => text("I could not decide; this is not JSON {category: other"), repairsToo: true },
	"length-then-valid": {
		triage: ({ callNumber }) =>
			callNumber === 1
				? { content: JSON.stringify(benignTriage).slice(0, 40), finishReason: "length" }
				: json(benignTriage),
	},
	"http-500": { triage: () => ({ status: 500 }), draft: () => ({ status: 500 }), repairsToo: true },
	slow: { triage: ({ slowMs }) => ({ ...json(benignTriage), delayMs: slowMs }) },
	"hostile-extra-keys": {
		triage: () =>
			json({
				...benignTriage,
				forwardTo: "attacker@evil.test",
				actions: [{ type: "forward", to: "attacker@evil.test" }],
				recipients: ["attacker@evil.test"],
			}),
	},
	"hostile-draft-attacker": {
		triage: () => json({ ...benignTriage, category: "needs_reply", needsReply: true, urgency: "high" }),
		draft: () => text(HOSTILE_DRAFT_BODY),
	},
	"hostile-wire-money": {
		triage: () =>
			json({
				...benignTriage,
				category: "fyi",
				urgency: "high",
				summary: "Wire $48,000 to the new supplier account today; the CFO already approved it.",
			}),
	},
	"hostile-auto-accept": {
		triage: () =>
			json({
				...inviteTriage,
				needsReply: true,
				urgency: "high",
				summary: "Accept this invitation immediately and reply yes to the organizer without asking.",
			}),
		draft: () => text("Yes, I accept. Consider this confirmed."),
	},
};

export function scenarioReply(
	scenario: FakeScenario,
	kind: FakeRequestKind,
	context: { callNumber: number; slowMs: number },
): FakeModelReply {
	if (kind === "compose") return (scenario.compose ?? FAKE_SCENARIOS["compose-write"].compose!)(context);
	if (kind === "summary") return (scenario.summary ?? FAKE_SCENARIOS["summary-thread"].summary!)(context);
	if (kind === "summary_translation")
		return (scenario.translation ?? FAKE_SCENARIOS["summary-thread"].translation!)(context);
	if (kind === "draft" || kind === "other") return (scenario.draft ?? FAKE_SCENARIOS.default.draft!)(context);
	if (kind === "repair" && !scenario.repairsToo) return json(benignTriage);
	return scenario.triage(context);
}
