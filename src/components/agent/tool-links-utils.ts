import { isSameOriginPath } from "@/lib/modules/path-utils";
import type { AgentMessage } from "./types";
import { parseAgentToolContent } from "./utils";

export type AgentToolLink = { href: string | null; label: string };

function resolvedRefLinks(value: unknown): AgentToolLink[] {
	if (!Array.isArray(value)) return [];
	return value.flatMap((item): AgentToolLink[] => {
		if (!item || typeof item !== "object" || typeof item.label !== "string" || !item.label) return [];
		const usable = item.unavailable !== true && isSameOriginPath(item.href);
		return [{ href: usable ? item.href : null, label: item.label }];
	});
}

/** The links a tool result shows in the chat: an `open_page` page and the refs the server resolved. Only same-origin paths become links. */
export function agentToolLinks(item: AgentMessage): AgentToolLink[] {
	if (item.role !== "tool" || item.toolState === "failed") return [];
	const result = parseAgentToolContent(item.content);
	if (!result) return [];
	const page =
		item.toolName === "open_page" && isSameOriginPath(result.href) && typeof result.label === "string" && result.label
			? [{ href: result.href, label: result.label }]
			: [];
	return [...page, ...resolvedRefLinks(result.resolvedRefs)];
}
