import { CLIENT_MODULES } from "@/lib/modules/client-data";
import { CORE_COMMANDS, CORE_SHORTCUTS } from "@/lib/modules/core-commands";
import type {
	CommandHandler,
	CommandParamField,
	CommandParamValues,
	CoreShortcut,
	JsonSchemaObject,
	JsonValue,
	ModuleId,
	UiCommand,
} from "@/lib/modules/module-types";
import { isSameOriginPath } from "@/lib/modules/path-utils";
import type { CommandItem } from "./types";

/**
 * Filter commands by matching title, subtitle, category, or keywords.
 */
export function filterCommands(commands: CommandItem[], query: string): CommandItem[] {
	const trimmed = query.trim();
	if (!trimmed) return commands;
	const lowerQuery = trimmed.toLowerCase();

	return commands.filter((cmd) => {
		const matchTitle = cmd.title.toLowerCase().includes(lowerQuery);
		const matchSubtitle = cmd.subtitle?.toLowerCase().includes(lowerQuery);
		const matchCategory = cmd.category.toLowerCase().includes(lowerQuery);
		const matchKeywords = cmd.keywords?.some((k) => k.toLowerCase().includes(lowerQuery));
		return matchTitle || matchSubtitle || matchCategory || matchKeywords;
	});
}

/**
 * Group commands by their category string.
 */
export function groupCommandsByCategory(commands: CommandItem[]): Record<string, CommandItem[]> {
	return commands.reduce(
		(acc, item) => {
			if (!acc[item.category]) acc[item.category] = [];
			acc[item.category].push(item);
			return acc;
		},
		{} as Record<string, CommandItem[]>,
	);
}

type CommandSource = { id: ModuleId; commands: readonly UiCommand[] };

type ListOptions = {
	/** The modules that are on for this user; omitted (no answer from the server yet) lists every module. */
	enabled?: readonly ModuleId[];
	/** Command ids a handler is available for right now. Client commands outside this set are not listed. */
	handlers?: ReadonlySet<string> | readonly string[];
	core?: readonly UiCommand[];
	modules?: readonly CommandSource[];
};

/**
 * The commands the palette and the shortcut bindings may offer: core's, plus those of every enabled
 * module in registry order. A client command needs a handler, so it appears only while one exists.
 */
export function listCommands({
	enabled,
	handlers = [],
	core = CORE_COMMANDS,
	modules = CLIENT_MODULES,
}: ListOptions = {}): UiCommand[] {
	const available = handlers instanceof Set ? handlers : new Set(handlers);
	const usable = (command: UiCommand) => command.target.type === "route" || available.has(command.id);
	const fromModules = modules
		.filter((source) => !enabled || enabled.includes(source.id))
		.flatMap((source) => source.commands);
	return [...core, ...fromModules].filter(usable);
}

export type ShortcutBinding = {
	key: string;
	label: string;
	category: CoreShortcut["category"];
	modifiers?: CoreShortcut["modifiers"];
	commandId?: string;
	chrome?: CoreShortcut["chrome"];
};

/**
 * The key bindings for a command list: core's own bindings whose command is listed (the palette shell's
 * keys always stay), then one per listed module command that declares a `shortcut`. A disabled module's
 * commands are not in the list, so its shortcuts never bind.
 */
export function listShortcutBindings(
	commands: readonly UiCommand[],
	coreShortcuts: readonly CoreShortcut[] = CORE_SHORTCUTS,
): ShortcutBinding[] {
	const listed = new Set(commands.map((command) => command.id));
	const core = coreShortcuts.filter(
		(shortcut) => shortcut.chrome || (shortcut.commandId && listed.has(shortcut.commandId)),
	);
	const taken = new Set(coreShortcuts.map((shortcut) => shortcut.key.toLowerCase()));
	const fromModules = commands
		.filter((command) => command.moduleId !== "core" && command.shortcut && !taken.has(command.shortcut.toLowerCase()))
		.map((command): ShortcutBinding => ({
			key: command.shortcut as string,
			label: command.label,
			category: command.effect === "navigate" ? "Navigation" : "Actions",
			commandId: command.id,
		}));
	return [...core, ...fromModules];
}

type ParamProperties = Record<string, JsonSchemaObject>;

function propertiesOf(schema: JsonSchemaObject | undefined): ParamProperties {
	const properties = schema?.properties;
	return properties && typeof properties === "object" && !Array.isArray(properties)
		? (properties as ParamProperties)
		: {};
}

function requiredNames(schema: JsonSchemaObject | undefined): string[] {
	return Array.isArray(schema?.required)
		? schema.required.filter((name): name is string => typeof name === "string")
		: [];
}

/** The inputs the palette asks for before it runs a command that takes parameters. */
export function commandParamFields(command: UiCommand): CommandParamField[] {
	const required = requiredNames(command.params);
	return Object.entries(propertiesOf(command.params)).map(([name, spec]) => ({
		name,
		required: required.includes(name),
		...(typeof spec.description === "string" ? { hint: spec.description } : {}),
	}));
}

function stringProblem(name: string, spec: JsonSchemaObject, value: string): string | null {
	if (typeof spec.minLength === "number" && value.length < spec.minLength) return `"${name}" is too short`;
	if (typeof spec.maxLength === "number" && value.length > spec.maxLength) return `"${name}" is too long`;
	if (typeof spec.pattern === "string") {
		try {
			if (!new RegExp(spec.pattern).test(value)) return `"${name}" is not in the expected form`;
		} catch {
			return `"${name}" cannot be checked`;
		}
	}
	return null;
}

function valueProblem(name: string, spec: JsonSchemaObject, value: JsonValue): string | null {
	if (Array.isArray(spec.enum) && !spec.enum.includes(value)) return `"${name}" is not one of the allowed values`;
	switch (spec.type) {
		case "string":
			return typeof value === "string" ? stringProblem(name, spec, value) : `"${name}" must be text`;
		case "integer":
			return Number.isInteger(value) ? null : `"${name}" must be a whole number`;
		case "number":
			return typeof value === "number" && Number.isFinite(value) ? null : `"${name}" must be a number`;
		case "boolean":
			return typeof value === "boolean" ? null : `"${name}" must be true or false`;
		default:
			return null;
	}
}

type ParamsResult = { ok: true; values: CommandParamValues } | { ok: false; error: string };

function isPlainObject(value: unknown): value is Record<string, JsonValue> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

/**
 * Checks values against a command's parameter schema. Names the schema does not declare are refused.
 * @public Consumed by the assistant's open_page tool and tests.
 */
export function validateCommandParams(schema: JsonSchemaObject | undefined, values: unknown = {}): ParamsResult {
	if (!isPlainObject(values)) return { ok: false, error: "Parameters must be an object" };
	const properties = propertiesOf(schema);
	for (const name of Object.keys(values)) {
		if (!Object.hasOwn(properties, name)) return { ok: false, error: `Unknown parameter "${name}"` };
	}
	for (const name of requiredNames(schema)) {
		if (values[name] === undefined || values[name] === "") return { ok: false, error: `Missing parameter "${name}"` };
	}
	for (const [name, value] of Object.entries(values)) {
		const problem = valueProblem(name, properties[name], value);
		if (problem) return { ok: false, error: problem };
	}
	return { ok: true, values };
}

const PLACEHOLDER = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

type HrefResult = { ok: true; href: string } | { ok: false; error: string };

/**
 * Fills a route command's `href` template from its params. Every value is validated against the
 * declared schema and URL-encoded, a placeholder must name a declared param, and the result must be a
 * same-origin path, so a param can never send the tab to another origin.
 * @public Consumed by the assistant's open_page tool and tests.
 */
export function fillCommandHref(command: UiCommand, values: unknown = {}): HrefResult {
	if (command.target.type !== "route") return { ok: false, error: `${command.label} does not open a page` };
	const checked = validateCommandParams(command.params, values);
	if (!checked.ok) return checked;
	const declared = propertiesOf(command.params);
	let problem: string | null = null;
	const href = command.target.href.replace(PLACEHOLDER, (_match, name: string) => {
		const value = checked.values[name];
		if (!Object.hasOwn(declared, name)) problem = `${command.id} names the undeclared parameter "${name}"`;
		else if (value === undefined) problem = `Missing parameter "${name}"`;
		return encodeURIComponent(String(value));
	});
	if (problem) return { ok: false, error: problem };
	return isSameOriginPath(href) ? { ok: true, href } : { ok: false, error: `${command.label} has no valid page` };
}

/** Maps the handlers a module's client chunk exports (by handler name) onto the commands that name them. */
export function handlersByCommandId(
	commands: readonly UiCommand[],
	byName: Readonly<Record<string, CommandHandler | undefined>>,
): Record<string, CommandHandler> {
	const handlers: Record<string, CommandHandler> = {};
	for (const command of commands) {
		const handler = command.target.type === "client" ? byName[command.target.handler] : undefined;
		if (handler) handlers[command.id] = handler;
	}
	return handlers;
}

type RunDeps = {
	navigate: (href: string) => void;
	/** Handlers by command id. */
	handlers: Readonly<Record<string, CommandHandler | undefined>>;
};

/** Runs a command the way a click would: a route navigates, a client command calls its handler. */
export async function runCommand(
	command: UiCommand,
	deps: RunDeps,
	values?: unknown,
): Promise<{ ok: true } | { ok: false; error: string }> {
	if (command.target.type === "route") {
		const filled = fillCommandHref(command, values);
		if (!filled.ok) return filled;
		deps.navigate(filled.href);
		return { ok: true };
	}
	const handler = deps.handlers[command.id];
	if (!handler) return { ok: false, error: `${command.label} is not available right now` };
	const checked = validateCommandParams(command.params, values);
	if (!checked.ok) return checked;
	try {
		await handler({ navigate: deps.navigate, params: checked.values });
		return { ok: true };
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : `${command.label} failed` };
	}
}
