import type { ZodType } from "zod";
import type { CapabilityCallContext, CapabilityHandler, JsonValue } from "@/lib/modules/module-types";
import { storedInverse, type StoredInverse } from "./action-input";
import { syncCalendarReminder } from "./calendar-reminder";
import { FinanceRefusal, refusalOf } from "./errors";
import {
	chargeFromJson,
	derivedId,
	fieldColumns,
	subscriptionFromJson,
	subscriptionRef,
	type SubscriptionRow,
} from "./record-utils";
import {
	deleteDocuments,
	deleteSubscriptionWithOnly,
	hasOtherDocument,
	ownerRow,
	restoreRows,
	updateSubscription,
} from "./subscriptions";

export type ExecuteCall<Input> = {
	actionId: string;
	userId: string;
	ctx: CapabilityCallContext;
	suggestion: { id: string | null; messageId: string | null; mailboxId: string };
	input: Input;
	/** The caller's saved state (a row or removal snapshot), as JSON; the same on a resumed run. */
	before: Record<string, unknown> | null;
};

export type ActionOutcome = { result: Record<string, JsonValue>; inverse: StoredInverse | null };

type RawCall =
	| {
			op: "execute";
			actionId: string;
			suggestion: ExecuteCall<unknown>["suggestion"];
			input?: JsonValue;
			before?: JsonValue;
	  }
	| { op: "undo" | "authorize_undo"; actionId: string; inverse: { inverse: JsonValue } };

/** The result every Money Watch action reports: the subscription it is about, which Activity links. */
export function actionResult(subscriptionId: string, extra: Record<string, JsonValue> = {}): Record<string, JsonValue> {
	return { ref: subscriptionRef(subscriptionId), subscriptionId, ...extra };
}

/**
 * Undoes what one action stored: deletes the row it created, puts back the fields it changed,
 * removes only the documents it inserted, and re-inserts what it removed with the same ids. Each
 * step is a no-op when already done, so a retried undo changes nothing more.
 */
async function undoStored(inverse: StoredInverse, actionId: string): Promise<void> {
	const { userId, subscriptionId } = inverse;
	if (inverse.created) {
		if (!(await deleteSubscriptionWithOnly(userId, subscriptionId, ownDocumentIds(inverse, actionId))))
			throw laterDocumentsRefusal();
		return;
	}
	if (inverse.removed) {
		const subscription = inverse.removed.subscription ? subscriptionFromJson(inverse.removed.subscription) : null;
		// The reminder event went with the row; the calendar sync after the undo puts it back.
		await restoreRows(
			subscription && { ...subscription, calendarEventId: null },
			inverse.removed.documents.map(chargeFromJson),
		);
	}
	if (inverse.previous && Object.keys(inverse.previous).length > 0 && (await ownerRow(userId, subscriptionId)))
		await updateSubscription(userId, subscriptionId, fieldColumns(inverse.previous));
	await deleteDocuments(userId, inverse.documentIds ?? []);
}

/**
 * The documents Track recorded. An inverse stored before creates kept `documentIds` names none, so
 * the only one it can own is the document whose id derives from the action, as Track records it.
 */
function ownDocumentIds(inverse: StoredInverse, actionId: string): string[] {
	return inverse.documentIds ?? [derivedId("fdoc", actionId)];
}

const laterDocumentsRefusal = () =>
	new FinanceRefusal(409, "Later documents were recorded for this subscription; remove it from Money Watch instead");

/**
 * Undoing a create deletes the row, and its documents cascade with it, so it is refused once the row
 * holds a document this action did not record. The delete itself checks again (`undoStored`).
 */
async function refuseLaterDocuments(inverse: StoredInverse, actionId: string): Promise<void> {
	if (await hasOtherDocument(inverse.subscriptionId, ownDocumentIds(inverse, actionId))) throw laterDocumentsRefusal();
}

function undoInverse(call: Extract<RawCall, { op: "undo" | "authorize_undo" }>): StoredInverse | null {
	const parsed = storedInverse.safeParse(call.inverse?.inverse);
	return parsed.success ? parsed.data : null;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
	!!value && typeof value === "object" && !Array.isArray(value);

/**
 * The row before this action ran, from the `before` its caller saved, when that names this row of this
 * owner; null otherwise. A resumed action may already have changed the row, so its earlier values come
 * from here rather than from the row as it is now.
 */
export function priorRow(
	before: Record<string, unknown> | null,
	userId: string,
	row: SubscriptionRow,
): SubscriptionRow | null {
	return before && before.id === row.id && before.userId === userId ? subscriptionFromJson(before) : null;
}

/**
 * Whether the row had a calendar event before the action, from the row its caller saved or the
 * removal snapshot. Only the fact is kept: the event may be gone, so its id is never restored.
 */
function hadCalendarEvent(row: Record<string, unknown> | null | undefined, subscriptionId: string): boolean {
	return !!row && row.id === subscriptionId && typeof row.calendarEventId === "string";
}

function restoresCalendarEvent(inverse: StoredInverse): boolean {
	return inverse.calendarEvent === true || hadCalendarEvent(inverse.removed?.subscription, inverse.subscriptionId);
}

type ActionOptions = {
	/** The action can change whether or when the subscription's calendar reminder applies. */
	syncsReminder?: boolean;
};

async function run<Input>(
	raw: JsonValue,
	ctx: CapabilityCallContext,
	schema: ZodType<Input>,
	execute: (call: ExecuteCall<Input>) => Promise<ActionOutcome>,
	options: ActionOptions,
): Promise<JsonValue> {
	const viewer = ctx.viewer;
	if (!viewer) throw new FinanceRefusal(403, "This action needs a signed-in user");
	const call = raw as unknown as RawCall;
	if (call.op === "execute") {
		const input = schema.safeParse(call.input);
		if (!input.success) throw new FinanceRefusal(409, "The action's input is not valid");
		const { actionId, suggestion } = call;
		const before = isObject(call.before) ? call.before : null;
		const outcome = await execute({ actionId, userId: viewer.userId, ctx, suggestion, input: input.data, before });
		const subscriptionId = outcome.result.subscriptionId;
		if (options.syncsReminder && typeof subscriptionId === "string") {
			if (outcome.inverse && !outcome.inverse.removed && hadCalendarEvent(before, subscriptionId))
				outcome.inverse.calendarEvent = true;
			await syncCalendarReminder(ctx, viewer.userId, subscriptionId);
		}
		// Optional inverse fields may be undefined, which is not JSON.
		const inverse = outcome.inverse ? (JSON.parse(JSON.stringify(outcome.inverse)) as JsonValue) : null;
		return { result: outcome.result, inverse };
	}
	const inverse = undoInverse(call);
	if (inverse && inverse.userId !== viewer.userId)
		throw new FinanceRefusal(403, "Only the owner can change this subscription");
	if (inverse?.created) await refuseLaterDocuments(inverse, call.actionId);
	if (inverse && call.op === "undo") {
		await undoStored(inverse, call.actionId);
		if (options.syncsReminder)
			await syncCalendarReminder(ctx, inverse.userId, inverse.subscriptionId, {
				restore: restoresCalendarEvent(inverse),
			});
	}
	return { result: {}, inverse: null };
}

/**
 * The handler behind one Money Watch `action` capability. `op` selects execute, undo or the check
 * before an undo; all three are idempotent by `actionId`. Only the subscription's owner may undo,
 * and a refusal is answered, never thrown, so the executor records it.
 */
export function financeAction<Input>(
	schema: ZodType<Input>,
	execute: (call: ExecuteCall<Input>) => Promise<ActionOutcome>,
	options: ActionOptions = {},
): CapabilityHandler {
	return async (raw, ctx) => {
		try {
			return await run(raw, ctx, schema, execute, options);
		} catch (error) {
			const refusal = refusalOf(error);
			if (!refusal) throw error;
			return {
				result: {},
				inverse: null,
				refused: { status: refusal.status === 403 ? 403 : 409, error: refusal.error },
			};
		}
	};
}

/** The owner's row an action changes; 409 when it is gone. */
export async function requireRow(userId: string, subscriptionId: string) {
	const row = await ownerRow(userId, subscriptionId);
	if (!row) throw new FinanceRefusal(409, "The subscription is no longer tracked");
	return row;
}
