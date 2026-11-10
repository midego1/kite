import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { storageColdRules } from "@/db/schema/storage";
import { createAuditLog } from "@/lib/mailboxes/audit";
import { R2_IA_TARGET } from "./cold-utils";
import { coldStorageTablesReady, readStorageConfig } from "./config";
import { DEFAULT_STORE_ID, isRoutableClass, isUsableStore, type StorageConfig } from "./config-utils";
import { unpurgedMigrationFrom } from "./migration-purge";
import type { RoutableClass } from "./types";

const CLASS_LABELS: Record<string, string> = { mail: "Mail", drive: "Drive", backups: "Backups" };

/** A class's name as the admin sees it, for messages. */
export function classLabel(objectClass: string): string {
	return CLASS_LABELS[objectClass] ?? objectClass;
}

/**
 * Whether `target` is a rule an admin may save: `r2-ia` always (a rule can be saved ahead of a runtime or
 * capability change that later makes it usable; the sweep itself quietly does nothing for an item whose store
 * cannot hold that storage class yet), or a store that is neither the default nor blocked.
 */
function isUsableColdTarget(config: StorageConfig, target: string): boolean {
	if (target === R2_IA_TARGET) return true;
	return target !== DEFAULT_STORE_ID && isUsableStore(config, target);
}

type SaveColdRuleInput = { afterDays: number; minBytes: number; target: string; enabled: boolean };

/** `updated_at` is stored in whole seconds (`mode: "timestamp"`), so a save answers with exactly that value: an
 * answer with milliseconds never matched the next refetch, and the next save from the same form read as a
 * conflict (CodeRabbit). */
function wholeSeconds(date: Date): Date {
	return new Date(Math.floor(date.getTime() / 1000) * 1000);
}

/**
 * Upserts one class's rule, returning the moment it was saved, or null when `expected` was given and no longer
 * matches (optimistic concurrency, CodeRabbit): `expected` is the `updatedAt` the client's form was loaded with,
 * null for a class that had no saved rule yet, and the write itself is conditional on it, so two tabs cannot
 * both pass a read-then-write check. `undefined` skips the check (an API client that never sends it).
 * `updateColdRule` validates `target` first.
 */
async function saveColdRule(
	env: CloudflareEnv,
	actorId: string,
	objectClass: RoutableClass,
	input: SaveColdRuleInput,
	expected: Date | null | undefined,
): Promise<Date | null> {
	const now = wholeSeconds(new Date());
	const db = getDb(env);
	const values = { ...input, updatedAt: now, updatedBy: actorId };
	if (expected === undefined)
		await db
			.insert(storageColdRules)
			.values({ objectClass, ...values })
			.onConflictDoUpdate({ target: storageColdRules.objectClass, set: values });
	else {
		const result =
			expected === null
				? await db
						.insert(storageColdRules)
						.values({ objectClass, ...values })
						.onConflictDoNothing()
				: await db
						.update(storageColdRules)
						.set(values)
						.where(
							and(
								eq(storageColdRules.objectClass, objectClass),
								eq(storageColdRules.updatedAt, wholeSeconds(expected)),
							),
						);
		if (!(result.meta?.changes ?? 0)) return null;
	}
	await createAuditLog(env, {
		actorUserId: actorId,
		action: "storage.cold_rule_saved",
		metadata: { objectClass, ...input },
	});
	return now;
}

/** The body's `expectedUpdatedAt`: absent skips the check, null means "no rule saved yet", else an ISO time. */
function expectedUpdatedAt(value: unknown): Date | null | undefined | "invalid" {
	if (value === undefined) return undefined;
	if (value === null) return null;
	if (typeof value !== "string") return "invalid";
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? "invalid" : date;
}

type ColdRuleFailure = { ok: false; status: number; error: string; field?: string; code?: string };
export type ColdRuleResult = ({ ok: true } & { rule: SaveColdRuleInput & { updatedAt: string } }) | ColdRuleFailure;

const MAX_AFTER_DAYS = 3650;

/** The rule fields of a request body, or why they are not acceptable (before any store is looked at). */
function parseColdRuleBody(
	body: unknown,
): { input: SaveColdRuleInput; expected: Date | null | undefined } | ColdRuleFailure {
	if (!body || typeof body !== "object") return { ok: false, status: 400, error: "Choose the age, size and target" };
	const { afterDays, minBytes, target, enabled, expectedUpdatedAt: expectedValue } = body as Record<string, unknown>;
	if (typeof afterDays !== "number" || !Number.isInteger(afterDays) || afterDays < 1 || afterDays > MAX_AFTER_DAYS)
		return { ok: false, status: 400, error: `Enter an age from 1 to ${MAX_AFTER_DAYS} days`, field: "afterDays" };
	if (typeof minBytes !== "number" || !Number.isInteger(minBytes) || minBytes < 0)
		return { ok: false, status: 400, error: "Enter a minimum size of 0 or more bytes", field: "minBytes" };
	if (typeof target !== "string" || !target)
		return { ok: false, status: 400, error: "Choose a target", field: "target" };
	if (typeof enabled !== "boolean") return { ok: false, status: 400, error: "Choose whether the rule is on" };
	const expected = expectedUpdatedAt(expectedValue);
	if (expected === "invalid") return { ok: false, status: 400, error: "expectedUpdatedAt is not a valid time" };
	return { input: { afterDays, minBytes, target, enabled }, expected };
}

/** Validates a rule body (the age, the size floor, and `target` against the live stores) before saving it. */
export async function updateColdRule(
	env: CloudflareEnv,
	actorId: string,
	objectClass: string,
	body: unknown,
): Promise<ColdRuleResult> {
	if (!isRoutableClass(objectClass)) return { ok: false, status: 404, error: "Unknown object class" };
	if (!(await coldStorageTablesReady(env)))
		return {
			ok: false,
			status: 409,
			error: "Apply the pending database update first",
			code: "MIGRATION_PENDING",
		};
	const parsed = parseColdRuleBody(body);
	if ("ok" in parsed) return parsed;
	const { input, expected } = parsed;
	const config = await readStorageConfig(env);
	if (!isUsableColdTarget(config, input.target))
		return { ok: false, status: 404, error: "That target is not available", field: "target" };
	// A store a migration is still emptying (or may yet purge) is no place to archive into: the purge would
	// delete what the sweep puts there (round-10 review, `B7`). A rule saved off moves nothing, so it may wait.
	const migrating =
		input.enabled && input.target !== R2_IA_TARGET ? await unpurgedMigrationFrom(env, input.target) : null;
	if (migrating)
		return {
			ok: false,
			status: 409,
			error: `${classLabel(migrating.objectClass)} is still being moved off this store, or its old copies there have not been deleted yet; finish that migration (delete the old copies) or choose another target`,
			field: "target",
			code: "STORE_MIGRATING",
		};
	const savedAt = await saveColdRule(env, actorId, objectClass, input, expected);
	if (!savedAt)
		return {
			ok: false,
			status: 409,
			error: "Someone else changed this rule since the page loaded; reload before saving your own edit.",
			code: "RULE_CHANGED",
		};
	return { ok: true, rule: { ...input, updatedAt: savedAt.toISOString() } };
}
