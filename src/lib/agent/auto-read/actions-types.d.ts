import type { agentActions } from "@/db/schema/agent-auto-read";
import type { JsonValue } from "@/lib/modules/module-types";
import type { MessageFacts } from "./facts-types";
import type { AgentActionType, ExecutionContext, SenderPolicy } from "./policy-types";
import type { AutonomyLevel } from "./settings-types";

export type AgentActionRow = typeof agentActions.$inferSelect;

/** The mailbox permission an action, or its undo, uses. */
export type ActionPermission = "manage" | "send_on_behalf";

export type ActionUndoRule = {
	windowMs: number;
	permission: ActionPermission;
	/** Only the user whose permission the action used may undo it (drafts and sends belong to that user). */
	actingUserOnly: boolean;
	/** The action type the inverse is recorded as; defaults to the original action. */
	inverseAction?: AgentActionType;
};

export type ActionMeta = {
	executePermission: ActionPermission;
	/** Allowed `variant` values; `""` for actions with a single outcome. */
	variants: readonly string[];
	/** Undo rule per variant, falling back to `"*"`; null means the action cannot be undone. */
	undo: Readonly<Record<string, ActionUndoRule | null>>;
};

export type ActionPermissions = { canManage: boolean; canSendOnBehalf: boolean };

export type UndoRefusal = { status: 403 | 409; error: string };

/** What the executor checks before an agent-initiated action. */
export type AgentGate = {
	level: AutonomyLevel;
	facts: MessageFacts;
	senderPolicy: SenderPolicy | null;
	context: ExecutionContext;
};

/** Ids and results an effect reads and writes; stored in the row's `after`. */
export type ActionState = Record<string, unknown>;

export type ActionEffect = {
	/** Ids the side effect will use, generated before the pending row is written. */
	ids?: Record<string, string>;
	before?: unknown;
	apply(ids: Record<string, string>): Promise<ActionState>;
	/** For a resumed row: the effect's result when it already happened, otherwise null. */
	check?(ids: Record<string, string>): Promise<ActionState | null>;
	/** What `apply` learned that an undo needs; stored on the row in place of `before` when present. */
	takeInverse?(): JsonValue | null;
};

/** Who a module action runs for; the module sees only this JSON, never a session. */
export type ModuleActionViewer = { userId: string; role: string; isPrimaryAdmin: boolean; timeZone: string };

/** An action a module runs: core passes the call through `invokeCapability` and keeps the audit row. */
export type ModuleActionCall = {
	/** Everything the module needs beyond the suggestion ids core adds; JSON only. */
	input: Record<string, JsonValue>;
	/** The state the action replaces, saved with the pending row before the module runs, so an undo can restore it. */
	before?: JsonValue;
	viewer: ModuleActionViewer;
};

export type ExecuteActionInput = {
	env: CloudflareEnv;
	mailboxId: string;
	suggestionId?: string | null;
	messageId?: string | null;
	jobId?: string | null;
	action: AgentActionType;
	variant?: string;
	actingUserId: string;
	autonomy?: AutonomyLevel | null;
	now?: Date;
} & ({ effect: ActionEffect; module?: undefined } | { module: ModuleActionCall; effect?: undefined }) &
	({ initiator: "user"; permissions: ActionPermissions } | { initiator: "agent"; gate: AgentGate });

export type ExecuteActionResult = {
	/** `skipped`: an applied row already exists for this suggestion, action and variant. */
	status: "applied" | "skipped" | "blocked" | "failed";
	actionId: string;
	after: ActionState | null;
	reason: string | null;
};
