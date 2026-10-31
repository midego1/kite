import { AI_FEATURE_LABELS, type AiFeature } from "./ai-error-utils";
import {
	claudeThinkingDefault,
	describeOutputCap,
	describeThinking,
	describeUsage,
	DRAFT_ANSWER_TOKENS,
	THINKING_ROOM_TOKENS,
	thinksByDefault,
	TRIAGE_ANSWER_TOKENS,
	TRIAGE_EXTENSION_MAX_TOKENS,
	TRIAGE_LINE_TOKENS,
	type AiOutputBudget,
} from "./output-budget-utils";

/** One fact Kite knows about a group of failures, shown under Why? and sent with Ask AI. */
export type AiFailureFact = { label: string; value: string };

export type CutOffInput = {
	/** The provider's name as Admin → Agent shows it. */
	provider: string;
	/** The recorded provider id (`anthropic`, `cloudflare`, …), which tells whether Kite knows the model's thinking. */
	providerId: string | null;
	model: string | null;
	feature: AiFeature | null;
	/** The newest recorded budget of the group, or null when its failures predate budgets or never record one. */
	budget: AiOutputBudget | null;
};

const count = (value: number) => value.toLocaleString("en-US");
const thinkingRoom = `, plus ${count(THINKING_ROOM_TOKENS)} for thinking when a reasoning effort is set`;

/** Each automatic feature's output cap in words, for failures that did not record their own. */
const FEATURE_CAPS: Partial<Record<AiFeature, string>> = {
	auto_triage: `${count(TRIAGE_ANSWER_TOKENS)} tokens for the answer, plus up to ${TRIAGE_EXTENSION_MAX_TOKENS} for module extensions (Calendar, Money Watch) and ${TRIAGE_LINE_TOKENS} for the one-line summary${thinkingRoom}`,
	auto_draft: `${count(DRAFT_ANSWER_TOKENS)} tokens${thinkingRoom}`,
	line_summary: `80 tokens${thinkingRoom}`,
	compose: `${count(DRAFT_ANSWER_TOKENS)} to 3,000 tokens depending on the request${thinkingRoom}`,
};

/** Features whose cut-off failures record their budget, so one without it was recorded by an older Kite. */
const BUDGETED: ReadonlySet<AiFeature> = new Set(["auto_triage", "auto_draft", "line_summary"]);

/** What each feature asks for, from docs/assistant.md, so Ask AI can reason about Kite instead of guessing. */
export const AI_FEATURE_NOTES: Partial<Record<AiFeature, string>> = {
	auto_triage: `Automatic reading makes one request per incoming message, with no tools, and expects a small JSON object (category, whether a reply is needed, a short summary; active modules add a few fields). Output cap: ${FEATURE_CAPS.auto_triage}. Thinking tokens count against the cap. Kite switches thinking off for Anthropic models that allow it, sends effort low to ones that always think, and retries a cut-off answer once with double the cap.`,
	auto_draft: `Agent drafts write one plain-text reply per message, with no tools. Output cap: ${FEATURE_CAPS.auto_draft}.`,
	line_summary: `One-line summaries ask for one line of at most 140 characters. Output cap: ${FEATURE_CAPS.line_summary}.`,
	compose: `Write with Kite writes or rewrites one email. Output cap: ${FEATURE_CAPS.compose}.`,
};

function modelName(input: CutOffInput): string {
	return input.model ?? "the model";
}

function featureLabel(input: CutOffInput): string {
	return input.feature ? AI_FEATURE_LABELS[input.feature] : "Kite";
}

/** The fix for a recorded budget: what to change, given how thinking was set. */
function budgetFix(input: CutOffInput, budget: AiOutputBudget): string {
	const model = modelName(input);
	const anthropic = input.providerId === "anthropic";
	if (budget.thinking === "on" && anthropic && claudeThinkingDefault(input.model) === "always")
		return `${model} always thinks, even at effort low, which is the lowest Kite sends. Choose a model that can answer without thinking (Claude Haiku 5.5, for example) as the triage model under automatic reading in Admin → Agent.`;
	if (budget.thinking === "on")
		return `Clear ${model}'s reasoning effort, or set it to minimal, under the provider's models in Admin → Agent. Without an effort, Kite switches thinking off${anthropic ? "" : " where the provider allows it"}.`;
	if (budget.thinking === "default")
		return `${input.provider} decides whether ${model} thinks, and Kite cannot switch that off there. If it is a reasoning model, set its reasoning effort to minimal in Admin → Agent, or choose a model that does not reason as the triage model.`;
	const retried = budget.retried ? ", even at double the cap" : "";
	const modules =
		budget.extensionRoom > 0
			? " If it only happens with mail that a module reads (Calendar, Money Watch), turn that module's automatic reading switch off for the mailbox."
			: "";
	return `Thinking was already off, so the answer itself ran long${retried}. Choose another model in Admin → Agent.${modules}`;
}

function budgetCause(input: CutOffInput, budget: AiOutputBudget): string {
	const usage = describeUsage(budget);
	const retried = budget.retried ? " Kite had already retried once with double the cap." : "";
	return `${featureLabel(input)} capped ${modelName(input)}'s answer at ${describeOutputCap(budget)}, and the model ${usage ? `${usage}, and ` : ""}stopped before the answer was finished. Thinking was ${describeThinking(budget)}.${retried}`;
}

/** The cause and fix of a cut-off failure from what Kite recorded and knows about the feature and the model. */
export function explainCutOff(input: CutOffInput): { cause: string; fix: string } {
	if (input.budget) return { cause: budgetCause(input, input.budget), fix: budgetFix(input, input.budget) };
	const model = modelName(input);
	const cap = input.feature ? FEATURE_CAPS[input.feature] : undefined;
	const capped = cap ? `${featureLabel(input)} caps the answer at ${cap}, and ` : "";
	const older = !!input.feature && BUDGETED.has(input.feature);
	if (thinksByDefault(input.providerId, input.model))
		return {
			cause: `${capped}${model} thinks before it answers unless the request switches thinking off. Thinking counts against the same cap, so it ran out before the answer was finished.`,
			fix: older
				? `These failures were recorded by a Kite that left thinking on. Kite now switches thinking off for ${model} on automatic requests (a model that always thinks gets effort low) and retries a cut-off answer once with double the cap, so they need no action. New failures will show their cap and thinking setting here.`
				: `Set ${model}'s reasoning effort to minimal or low in Admin → Agent, or choose a model that thinks less.`,
		};
	return {
		cause: `${capped}the model stopped before its answer was finished: a model that writes long, or reasons at length when its provider turns reasoning on.`,
		fix: `Set ${model}'s reasoning effort to minimal (or clear it) in Admin → Agent, or choose another model.`,
	};
}

/** The facts Kite knows about a cut-off group: the cap, the thinking setting, the usage and the retry. */
export function cutOffFacts(input: CutOffInput): AiFailureFact[] {
	const { budget } = input;
	if (budget) {
		const facts = [
			{ label: "Output cap", value: describeOutputCap(budget) },
			{ label: "Thinking", value: describeThinking(budget) },
		];
		const usage = describeUsage(budget);
		if (usage) facts.push({ label: "Used", value: usage.replace(/^used /, "") });
		facts.push({ label: "Retry", value: budget.retried ? "cut off again at double the cap" : "none" });
		return facts;
	}
	const facts: AiFailureFact[] = [];
	const cap = input.feature ? FEATURE_CAPS[input.feature] : undefined;
	if (cap) facts.push({ label: "Output cap", value: `${cap} (not recorded for these failures)` });
	const thinks = thinksByDefault(input.providerId, input.model);
	if (thinks !== null)
		facts.push({
			label: "Thinking",
			value: thinks ? `${modelName(input)} thinks by default` : `${modelName(input)} does not think by default`,
		});
	return facts;
}
