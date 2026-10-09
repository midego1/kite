export const AGENT_MAX_STEPS_MIN = 3;
export const AGENT_MAX_STEPS_MAX = 30;
export const AGENT_MAX_STEPS_DEFAULT = 15;

export const AGENT_FINAL_STEP_INSTRUCTION =
	"This is your last step: tools are no longer available. Answer the user now using only what you have already found. If the task is not finished, say that you ran out of steps, summarise what you found so far, and suggest how the user can continue (for example by asking a narrower question or raising the step limit in the assistant settings).";

export const AGENT_STEP_LIMIT_FALLBACK =
	'I reached the step limit for this question before I could write an answer. Try a narrower question, or raise "Max steps per question" in the assistant settings.';

export function isAgentMaxSteps(value: unknown): value is number {
	return (
		typeof value === "number" && Number.isInteger(value) && value >= AGENT_MAX_STEPS_MIN && value <= AGENT_MAX_STEPS_MAX
	);
}

/** Coerces a stored or missing value into the allowed range, falling back to the default. */
export function clampAgentMaxSteps(value: unknown): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return AGENT_MAX_STEPS_DEFAULT;
	return Math.min(AGENT_MAX_STEPS_MAX, Math.max(AGENT_MAX_STEPS_MIN, Math.round(value)));
}

/**
 * Per-step overrides for `streamText`'s `prepareStep`. `stepNumber` is zero-based, so with
 * `stepCountIs(maxSteps)` the final step is `maxSteps - 1`; there tools are switched off so
 * the run cannot end on a tool call without any text for the user.
 */
export function agentStepSettings(
	stepNumber: number,
	maxSteps: number,
	system: string,
): { toolChoice: "none"; instructions: string } | undefined {
	if (stepNumber < maxSteps - 1) return undefined;
	return { toolChoice: "none", instructions: `${system}\n\n${AGENT_FINAL_STEP_INSTRUCTION}` };
}
