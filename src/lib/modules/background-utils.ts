import type { BackgroundDeps, BackgroundManifest, QueueDispatchResult } from "./background-types";
import type { CapabilityCallContext, JsonValue, ModuleId } from "./module-types";

/** Queue messages and cron triggers have no viewer and no session. */
function backgroundContext(trigger: "queue" | "cron", grants: string[]): CapabilityCallContext {
	return {
		viewer: null,
		requestId: crypto.randomUUID(),
		locale: "en",
		timeZone: "UTC",
		grants,
		trigger,
	};
}

function messageKind(body: unknown): string | null {
	if (typeof body !== "object" || body === null) return null;
	const kind = (body as { kind?: unknown }).kind;
	return typeof kind === "string" ? kind : null;
}

/** An error the consumer's retry handles; the code says why, and nothing the module threw is copied into it. @public Test-only: thrown here, matched only by tests. */
export class ModuleBackgroundError extends Error {
	constructor(
		message: string,
		readonly code: string,
	) {
		super(message);
		this.name = "ModuleBackgroundError";
	}
}

/** A manifest names the role of a queue; the consumer passes the deployed name, such as `kite-agent`. */
const queueHasRole = (queue: string, role: string) => queue === role || queue.endsWith(`-${role}`);

function queueEntry(manifests: readonly BackgroundManifest[], queue: string, kind: string | null) {
	if (!kind) return null;
	for (const manifest of manifests) {
		const entry = manifest.queueMessageTypes.find((item) => item.kind === kind && queueHasRole(queue, item.queue));
		if (entry) return { moduleId: manifest.id, entry };
	}
	return null;
}

/**
 * Builds the two functions core calls for background work. Which module owns a queue message or a cron
 * task comes from the manifests, so the entry points name no module.
 */
export function createModuleBackground(deps: BackgroundDeps) {
	/**
	 * Hands a queue message to the module whose manifest declares its kind on that queue. A message of a
	 * disabled module is acked and skipped, a transient failure is thrown so the consumer retries, and
	 * a message the module can never accept is acked, because a retry would not change the answer.
	 */
	async function dispatchModuleQueueMessage(_env: unknown, queue: string, body: unknown): Promise<QueueDispatchResult> {
		const kind = messageKind(body);
		const found = queueEntry(deps.manifests, queue, kind);
		if (!found) return { handled: false };
		const { moduleId, entry } = found;
		const ctx = backgroundContext("queue", deps.descriptorScopes(moduleId, entry.capability));
		const result = await deps.invoke(moduleId, entry.capability, body as JsonValue, ctx);
		if (result.ok) {
			const skipped = (result.output as { skipped?: unknown } | null)?.skipped;
			if (skipped === "module_disabled") deps.log.info("queue.module_disabled", { moduleId, kind });
			return { handled: true, result };
		}
		const { code } = result.error;
		if (code === "module_disabled") deps.log.info("queue.module_disabled", { moduleId, kind });
		else if (code === "handler_error" || code === "timeout")
			throw new ModuleBackgroundError(`Module queue message ${kind} failed: ${code}`, code);
		else deps.log.warn("queue.module_message_refused", { moduleId, kind, code });
		return { handled: true, result };
	}

	/**
	 * Runs every cron task whose schedule matches this trigger. A task of a disabled module is skipped, and
	 * a failing task is logged without stopping the others.
	 */
	async function runModuleCronTasks(_env: unknown, cron: string, now: Date): Promise<void> {
		const tasks = deps.manifests.flatMap((manifest) =>
			manifest.cronTasks
				.filter((task) => task.schedule === "every_tick" || task.schedule === cron)
				.map((task) => ({ moduleId: manifest.id as ModuleId, task })),
		);
		await Promise.all(
			tasks.map(async ({ moduleId, task }) => {
				const fields = { moduleId, task: task.name, cron, scheduledTime: now.toISOString() };
				try {
					const ctx = backgroundContext("cron", deps.descriptorScopes(moduleId, task.capability));
					const result = await deps.invoke(moduleId, task.capability, {}, ctx);
					if (result.ok) return;
					if (result.error.code === "module_disabled") deps.log.debug("cron.module_disabled", fields);
					else deps.log.warn("cron.task_failed", { ...fields, code: result.error.code });
				} catch (error) {
					deps.log.warn("cron.task_failed", { ...fields, code: "handler_error", error });
				}
			}),
		);
	}

	return { dispatchModuleQueueMessage, runModuleCronTasks };
}
