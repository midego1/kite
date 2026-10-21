import type { z } from "zod";
import { jsonValueProblem } from "./json-utils";
import type {
	CapabilityCallContext,
	CapabilityDescriptor,
	CapabilityErrorCode,
	CapabilityHandler,
	CapabilityResult,
	JsonValue,
	ModuleId,
} from "./module-types";

const DEFAULT_TIMEOUT_MS = 10_000;

export type InvokeEntry = {
	descriptor: CapabilityDescriptor;
	handler: CapabilityHandler;
	inputSchema: z.ZodType;
	outputSchema?: z.ZodType;
};

type InvokeLogEntry = {
	moduleId: ModuleId;
	capability: string;
	trigger: CapabilityCallContext["trigger"] | null;
	durationMs: number;
	code: "ok" | CapabilityErrorCode;
	/** The thrown value of a failing handler. It is logged and never returned, because results reach the model. */
	error?: unknown;
};

export type InvokerDeps = {
	lookup(moduleId: ModuleId, name: string): InvokeEntry | null;
	isEnabled(viewer: CapabilityCallContext["viewer"], moduleId: ModuleId): Promise<boolean>;
	log(entry: InvokeLogEntry): void;
	now?(): number;
};

const MESSAGES: Record<CapabilityErrorCode, string> = {
	unknown_capability: "Unknown capability",
	module_disabled: "This module is turned off",
	forbidden: "Not allowed",
	invalid_input: "Invalid input",
	invalid_output: "The capability returned an invalid result",
	not_found: "Not found",
	timeout: "The capability took too long",
	handler_error: "The capability failed",
};

function failure(code: CapabilityErrorCode, message?: string): CapabilityResult {
	const retryable = code === "timeout" || code === "handler_error";
	return { ok: false, error: { code, message: message ?? MESSAGES[code], ...(retryable ? { retryable } : {}) } };
}

function firstIssue(error: { issues: readonly { path: readonly PropertyKey[]; message: string }[] }): string {
	const issue = error.issues[0];
	if (!issue) return "Invalid input";
	return `${issue.path.map(String).join(".") || "input"}: ${issue.message}`;
}

function missingGrant(descriptor: CapabilityDescriptor, ctx: CapabilityCallContext): boolean {
	const held = Array.isArray(ctx.grants) ? ctx.grants : [];
	return (descriptor.scopes ?? []).some((scope) => !held.includes(scope));
}

/** The mailbox a `mailboxBound` input names, which `ctx.mailboxIds` must include. */
function mailboxOutsideContext(input: unknown, ctx: CapabilityCallContext): boolean {
	const named = input !== null && typeof input === "object" ? (input as { mailboxId?: unknown }).mailboxId : undefined;
	return typeof named !== "string" || !Array.isArray(ctx.mailboxIds) || !ctx.mailboxIds.includes(named);
}

async function runWithTimeout(
	handler: CapabilityHandler,
	input: JsonValue,
	ctx: CapabilityCallContext,
	timeoutMs: number,
): Promise<{ timedOut: true } | { timedOut: false; output: unknown }> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const call = Promise.resolve().then(() => handler(input, ctx));
	// A handler that outlives its timeout may still reject later; nobody is waiting for it.
	call.catch(() => undefined);
	const expired = new Promise<{ timedOut: true }>((resolve) => {
		timer = setTimeout(() => resolve({ timedOut: true }), timeoutMs);
	});
	try {
		return await Promise.race([call.then((output) => ({ timedOut: false as const, output })), expired]);
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Builds the one call contract between core and module code. The returned function checks, in order:
 * descriptor, module state (data and storage hooks exempt), grants and mailbox, JSON-only input and context,
 * the input schema, then runs the handler under a timeout and checks the output. It never throws.
 */
export function createInvoker(deps: InvokerDeps) {
	const now = deps.now ?? Date.now;

	async function execute(
		moduleId: ModuleId,
		name: string,
		input: JsonValue,
		ctx: CapabilityCallContext,
		report: (error: unknown) => void,
	): Promise<CapabilityResult> {
		const entry = deps.lookup(moduleId, name);
		if (!entry) return failure("unknown_capability");
		const { descriptor } = entry;
		const runsWhileOff = !!descriptor.lifecycle?.dataHook || !!descriptor.storage;
		if (!runsWhileOff && !(await deps.isEnabled(ctx.viewer, moduleId))) return failure("module_disabled");
		if (missingGrant(descriptor, ctx) || (descriptor.mailboxBound && mailboxOutsideContext(input, ctx)))
			return failure("forbidden");
		const jsonProblem = jsonValueProblem(input, "input") ?? jsonValueProblem(ctx, "context");
		if (jsonProblem) return failure("invalid_input", jsonProblem);
		const parsed = entry.inputSchema.safeParse(input);
		if (!parsed.success) return failure("invalid_input", firstIssue(parsed.error));
		const run = await runWithTimeout(
			entry.handler,
			parsed.data as JsonValue,
			structuredClone(ctx),
			descriptor.timeoutMs ?? DEFAULT_TIMEOUT_MS,
		).catch((error: unknown) => {
			report(error);
			return null;
		});
		if (!run) return failure("handler_error");
		if (run.timedOut) return failure("timeout");
		const outputProblem = jsonValueProblem(run.output, "output");
		if (outputProblem) return failure("invalid_output", outputProblem);
		if (!entry.outputSchema) return { ok: true, output: run.output as JsonValue };
		const checked = entry.outputSchema.safeParse(run.output);
		if (!checked.success) return failure("invalid_output", firstIssue(checked.error));
		return { ok: true, output: checked.data as JsonValue };
	}

	return async function invokeCapability(
		moduleId: ModuleId,
		name: string,
		input: JsonValue,
		ctx: CapabilityCallContext,
	): Promise<CapabilityResult> {
		const started = now();
		let thrown: unknown;
		let result: CapabilityResult;
		try {
			result = await execute(moduleId, name, input, ctx, (error) => (thrown = error));
		} catch (error) {
			thrown = error;
			result = failure("handler_error");
		}
		try {
			deps.log({
				moduleId,
				capability: name,
				trigger: ctx?.trigger ?? null,
				durationMs: now() - started,
				code: result.ok ? "ok" : result.error.code,
				...(thrown === undefined ? {} : { error: thrown }),
			});
		} catch {
			// Logging must never change the outcome of a call.
		}
		return result;
	};
}
