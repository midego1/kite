import type { ToolSet } from "ai";
import { listCapabilities } from "@/lib/modules/capability-registry";
import { listEnabledModules } from "@/lib/modules/state";
import { buildChatTools } from "../chat-tools";
import type { AgentToolContext } from "../types";

/**
 * Every tool an email request may call (spec §8.3): every core email tool `buildChatTools` builds — the
 * chat-origin approval gates in `organize-tools.ts`/`tools.ts` now also cover `"email"`, so none of them can act
 * without the owner confirming in Kite — plus `open_page`, and module `assistant_tool`s whose `effect` is `none`
 * or `read`. A write-effect module tool (Calendar's `create_event`, …) is never offered by email, and a tool a
 * later change adds to `buildChatTools` without updating this filter is absent until it is classified here —
 * this is a filter against the live set, not an opt-out list, so a new capability starts out excluded rather
 * than reachable by default.
 */
export async function buildEmailChatTools(context: AgentToolContext): Promise<{ tools: ToolSet; fragments: string[] }> {
	const { tools, fragments } = await buildChatTools(context);
	const viewer = { userId: context.user.id, role: context.user.role, isPrimaryAdmin: context.user.isPrimaryAdmin };
	const enabled = await listEnabledModules(context.env, viewer);
	const writeEffectNames = new Set(
		listCapabilities("assistant_tool", enabled)
			.filter(({ descriptor }) => descriptor.effect !== "none" && descriptor.effect !== "read")
			.map(({ descriptor }) => descriptor.name),
	);
	const filtered: ToolSet = Object.fromEntries(Object.entries(tools).filter(([name]) => !writeEffectNames.has(name)));
	return { tools: filtered, fragments };
}
