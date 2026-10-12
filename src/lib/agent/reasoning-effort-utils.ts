import type { AgentReasoningEffort } from "./provider-types";

/** Efforts every supported reasoning provider accepts; "none" is rejected by several of them with a 400. */
export const AGENT_REASONING_EFFORTS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;

export function parseAgentReasoningEffort(value: unknown): AgentReasoningEffort | undefined {
	return typeof value === "string" && (AGENT_REASONING_EFFORTS as readonly string[]).includes(value)
		? (value as AgentReasoningEffort)
		: undefined;
}
