import { fillCommandHref } from "@/components/shortcuts/command-palette-utils";
import type { JsonSchemaObject, UiCommand } from "@/lib/modules/module-types";
import type { ResolvedRecordRef } from "@/lib/modules/record-ref-types";

export const OPEN_PAGE_TOOL = "open_page";

/** A chat answer names at most this many refs; the rest are left out rather than resolved. */
const MAX_TOOL_REFS = 20;

/** Only navigation commands that open a route can become links. */
export function navigateCommands(commands: readonly UiCommand[]): UiCommand[] {
	return commands.filter((command) => command.effect === "navigate" && command.target.type === "route");
}

/** The input schema of `open_page` for one request: the command enum lists exactly the commands offered. */
export function openPageSchema(commands: readonly UiCommand[]): JsonSchemaObject {
	return {
		type: "object",
		properties: {
			command: { type: "string", enum: commands.map((command) => command.id) },
			params: {
				type: "object",
				description: 'Only for pages that list parameters, for example {"date":"2026-11-03"}.',
			},
		},
		required: ["command"],
		additionalProperties: false,
	};
}

function paramNames(command: UiCommand): string {
	const names = Object.keys((command.params?.properties as Record<string, unknown> | undefined) ?? {});
	return names.length ? ` (params: ${names.join(", ")})` : "";
}

export function openPageDescription(commands: readonly UiCommand[]): string {
	const pages = commands.map((command) => `${command.id}: ${command.label}${paramNames(command)}`).join("; ");
	return `Give the user a link to a page in Kite. They click it to open the page; nothing opens by itself. Use it when the user asks to go somewhere or a page would help. Pages: ${pages}.`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Turns an `open_page` call into `{ href, label }`. The command must be one of the offered ids and its
 * params are checked and URL-encoded by `fillCommandHref`, so a call can only name a same-origin page.
 */
export function runOpenPage(commands: readonly UiCommand[], input: unknown): { href: string; label: string } {
	if (!isPlainObject(input)) throw new Error("Give a command and its parameters as an object");
	const command = typeof input.command === "string" ? commands.find((item) => item.id === input.command) : undefined;
	if (!command) throw new Error("That page is not available; use one of the listed commands");
	const filled = fillCommandHref(command, input.params);
	if (!filled.ok) throw new Error(filled.error);
	return { href: filled.href, label: command.label };
}

function asRef(value: unknown): { kind: string; id: string } | null {
	if (!isPlainObject(value)) return null;
	return typeof value.kind === "string" && value.kind && typeof value.id === "string" && value.id
		? { kind: value.kind, id: value.id }
		: null;
}

/** The record refs a tool result names in `ref` or `refs`. */
export function collectToolRefs(output: unknown): { kind: string; id: string }[] {
	if (!isPlainObject(output)) return [];
	const found = [output.ref, ...(Array.isArray(output.refs) ? output.refs : [])].flatMap((value) => asRef(value) ?? []);
	return found.slice(0, MAX_TOOL_REFS);
}

/** Adds the resolved refs for the chat to draw; the model and the stored history only see the plain refs. */
export function withResolvedRefs(output: unknown, resolved: readonly ResolvedRecordRef[]): unknown {
	if (!isPlainObject(output) || resolved.length === 0) return output;
	return { ...output, resolvedRefs: resolved };
}
