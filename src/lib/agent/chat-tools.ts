import { jsonSchema, type ToolSet } from "ai";
import { listCommands } from "@/components/shortcuts/command-palette-utils";
import { MODULE_CAPABILITIES, listCapabilities } from "@/lib/modules/capability-registry";
import { buildCallContext, selectPromptFragments } from "@/lib/modules/capability-utils";
import { invokeCapability } from "@/lib/modules/invoke";
import type { JsonSchemaObject, JsonValue } from "@/lib/modules/module-types";
import { MODULE_MANIFESTS } from "@/lib/modules/registry";
import { listEnabledModules } from "@/lib/modules/state";
import { resolveRecordRefs } from "@/lib/modules/record-refs";
import { normalizeTimeZone } from "@/lib/time/utils";
import {
	OPEN_PAGE_TOOL,
	collectToolRefs,
	navigateCommands,
	openPageDescription,
	openPageSchema,
	runOpenPage,
	withResolvedRefs,
} from "./chat-tools-utils";
import { EMAIL_TOOL_NAMES, emailToolDescriptions, emailToolSchemas, runEmailTool } from "./tools";
import { agentToday } from "./time";
import type { AgentToolContext } from "./types";

type ToolSchema = Parameters<typeof jsonSchema>[0];

/** The `$schema` keyword names a draft, which providers do not need and some reject. */
function toolSchema(schema: JsonSchemaObject): ToolSchema {
	const { $schema: _draft, ...rest } = schema;
	return rest as ToolSchema;
}

/**
 * The tools and prompt text one chat request offers: the core email tools, `open_page`, and the
 * `assistant_tool` descriptors and prompt fragments of the modules enabled for the user. Every module
 * tool runs through `invokeCapability` with a chat context, so module state and grants are checked there.
 */
export async function buildChatTools(context: AgentToolContext) {
	const timeZone = normalizeTimeZone(context.timeZone);
	const viewer = { userId: context.user.id, role: context.user.role, isPrimaryAdmin: context.user.isPrimaryAdmin };
	const enabled = await listEnabledModules(context.env, viewer);
	const callContext = buildCallContext({
		trigger: "chat",
		viewer,
		timeZone,
		mailboxIds: [context.mailboxId],
		enabled,
		manifests: MODULE_MANIFESTS,
	});
	const tools: ToolSet = Object.fromEntries(
		EMAIL_TOOL_NAMES.map((name) => [
			name,
			{
				description: emailToolDescriptions[name],
				inputSchema: emailToolSchemas[name],
				execute: async (input: unknown) => runEmailTool(context, name, input),
			},
		]),
	);
	const commands = navigateCommands(listCommands({ enabled }));
	tools[OPEN_PAGE_TOOL] = {
		description: openPageDescription(commands),
		inputSchema: jsonSchema(toolSchema(openPageSchema(commands))),
		execute: async (input: unknown) => runOpenPage(commands, input),
	};
	for (const { moduleId, descriptor } of listCapabilities("assistant_tool", enabled)) {
		// A module can never replace a core tool, or another module's tool, by reusing its name.
		if (Object.hasOwn(tools, descriptor.name)) continue;
		tools[descriptor.name] = {
			description: descriptor.description,
			inputSchema: jsonSchema(toolSchema(descriptor.inputSchema)),
			execute: async (input: unknown) => {
				const result = await invokeCapability(moduleId, descriptor.name, input as JsonValue, callContext);
				if (!result.ok) throw new Error(result.error.message);
				return result.output;
			},
		};
	}
	const fragments = selectPromptFragments(MODULE_CAPABILITIES, enabled, { timeZone, today: agentToday(timeZone) });
	return { tools, fragments };
}

/** A tool result with the record refs it names resolved for the viewer; a result without refs is returned as is. */
export async function resolveToolResultRefs(context: AgentToolContext, output: unknown): Promise<unknown> {
	const refs = collectToolRefs(output);
	if (refs.length === 0) return output;
	const viewer = { userId: context.user.id, role: context.user.role, isPrimaryAdmin: context.user.isPrimaryAdmin };
	const resolved = await resolveRecordRefs(context.env, viewer, refs, {
		timeZone: normalizeTimeZone(context.timeZone),
	});
	return withResolvedRefs(output, resolved);
}

type HistoryRow = { role: string; content: string };

function parseToolContent(content: string): unknown {
	if (!content.startsWith("{")) return null;
	try {
		return JSON.parse(content);
	} catch {
		return null;
	}
}

/**
 * Chat history rows with the refs of stored tool results resolved now, so a record the viewer can no
 * longer see (or a module that has since been turned off) shows as plain text instead of an old title.
 * One batch serves every row.
 */
export async function attachHistoryRefs<T extends HistoryRow>(context: AgentToolContext, rows: T[]): Promise<T[]> {
	const parsed = rows.map((row) => (row.role === "tool" ? parseToolContent(row.content) : null));
	const refs = parsed.flatMap((output) => collectToolRefs(output));
	if (refs.length === 0) return rows;
	const viewer = { userId: context.user.id, role: context.user.role, isPrimaryAdmin: context.user.isPrimaryAdmin };
	const resolved = await resolveRecordRefs(context.env, viewer, refs, {
		timeZone: normalizeTimeZone(context.timeZone),
	}).catch(() => null);
	if (!resolved) return rows;
	const byRef = new Map(resolved.map((item) => [`${item.kind}:${item.id}`, item]));
	return rows.map((row, index) => {
		const own = collectToolRefs(parsed[index]).flatMap((ref) => byRef.get(`${ref.kind}:${ref.id}`) ?? []);
		return own.length ? { ...row, content: JSON.stringify(withResolvedRefs(parsed[index], own)) } : row;
	});
}
