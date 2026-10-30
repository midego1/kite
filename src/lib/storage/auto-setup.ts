import { createAuditLog } from "@/lib/mailboxes/audit";
import { completeStorageAttempt } from "./test-limit";
import { isNodeRuntime } from "@/lib/runtime";
import { createLogger } from "@/lib/logger.mjs";
import { ne } from "drizzle-orm";
import { getDb } from "@/db";
import { domains } from "@/db/schema";
import { readStorageConfig, storageTablesReady } from "./config";
import {
	createR2Bucket,
	createR2BucketToken,
	deleteR2Token,
	deleteR2TokenNamed,
	listR2Buckets,
	R2ApiError,
	r2ApiConfigured,
	r2ApiTestOrigin,
	r2S3Endpoint,
	r2S3TestEndpoint,
	r2TokenName,
	resolveR2Account,
	restoreR2BucketCors,
	setR2BucketCors,
	type CallLimits,
	type R2Bucket,
} from "./cloudflare-r2";
import {
	DEFAULT_BINDING_BUCKET,
	isBucketExists,
	isPermissionRefusal,
	permissionForStep,
	permissionMessage,
	R2_SETUP_STEP_LABELS,
	type R2CorsRule,
	type R2Jurisdiction,
	type R2SetupStepId,
} from "./cloudflare-r2-utils";
import { recordDirectUploadsSetup, type DirectUploadsSetupRecord } from "./direct-uploads-state";
import { probeKey } from "./health";
import { rawEnvOf } from "./index";
import { S3Bucket } from "./s3-bucket";
import { corsOrigins, parseStoreInput } from "./store-input-utils";
import { createStore, type StoreView } from "./stores";
import type { S3Credentials } from "./types";
import type { ValidationReport } from "./validate-utils";

const log = createLogger("storage");

type R2SetupStep = {
	id: R2SetupStepId;
	label: string;
	status: "ok" | "failed" | "skipped";
	detail?: string;
};

type R2SetupFailure = {
	ok: false;
	status: number;
	error: string;
	steps: R2SetupStep[];
	/** `bucket_exists`: the name is taken in this account, and the admin may choose to use it. */
	code?: "bucket_exists" | "already_connected" | "permission" | "unavailable" | "checks_failed" | "timeout";
	/** The account permission CF_TOKEN lacks, as the dashboard names it. */
	permission?: string;
	report?: ValidationReport;
};

export type R2SetupResult =
	{ ok: true; steps: R2SetupStep[]; store: StoreView; report: ValidationReport } | R2SetupFailure;

/** What the automatic setup needs before it may run; the reason is shown as is. */
export async function r2AutoSetupAvailability(env: CloudflareEnv): Promise<{ available: boolean; reason?: string }> {
	if (isNodeRuntime(env) && !r2ApiTestOrigin(env))
		return { available: false, reason: "Files stay in Kite's data directory on this server; there is no R2 bucket." };
	if (!r2ApiConfigured(env))
		return { available: false, reason: "CF_TOKEN is not set, so Kite cannot call Cloudflare." };
	if (!env.APP_ENCRYPTION_KEY?.trim())
		return { available: false, reason: "Set APP_ENCRYPTION_KEY first: store keys are only ever saved encrypted." };
	if (!(await storageTablesReady(env))) return { available: false, reason: "Apply the pending database update first." };
	return { available: true };
}

/** Zones Kite manages, whose account is the one Kite runs in (so `GET /accounts` is rarely needed). */
async function knownZoneIds(env: CloudflareEnv): Promise<string[]> {
	try {
		const rows = await getDb(env)
			.select({ zoneId: domains.zoneId })
			.from(domains)
			.where(ne(domains.zoneId, "manual"))
			.limit(3);
		return rows.map((row) => row.zoneId).filter(Boolean);
	} catch {
		return [];
	}
}

/** The account and its buckets for the picker; a refusal names the permission instead of failing the page. */
export async function r2BucketChoices(
	env: CloudflareEnv,
): Promise<{ accountId: string | null; buckets: R2Bucket[]; error?: string; permission?: string }> {
	let accountId: string | null = null;
	try {
		accountId = await resolveR2Account(env, await knownZoneIds(env));
		const [plain, eu] = await Promise.all([
			listR2Buckets(env, accountId),
			listR2Buckets(env, accountId, "eu").catch(() => [] as R2Bucket[]),
		]);
		return { accountId, buckets: [...plain, ...eu] };
	} catch (error) {
		const failure = describeApiError(error);
		return {
			accountId,
			buckets: [],
			error: failure.message,
			...(failure.permission ? { permission: failure.permission } : {}),
		};
	}
}

function describeApiError(error: unknown): { message: string; permission?: string } {
	if (!(error instanceof R2ApiError)) return { message: "Cloudflare's API could not be reached." };
	if (isPermissionRefusal(error))
		return { message: permissionMessage(error.step), permission: permissionForStep(error.step) ?? undefined };
	return { message: `Cloudflare answered: ${error.message}` };
}

class Progress {
	readonly steps: R2SetupStep[] = [];

	constructor(private readonly plan: R2SetupStepId[]) {}

	ok(id: R2SetupStepId, detail?: string) {
		this.steps.push({ id, label: R2_SETUP_STEP_LABELS[id], status: "ok", ...(detail ? { detail } : {}) });
	}

	fail(id: R2SetupStepId, detail: string): R2SetupStep[] {
		this.steps.push({ id, label: R2_SETUP_STEP_LABELS[id], status: "failed", detail });
		for (const rest of this.plan)
			if (!this.steps.some((step) => step.id === rest))
				this.steps.push({ id: rest, label: R2_SETUP_STEP_LABELS[rest], status: "skipped" });
		return this.steps;
	}
}

class StepError extends Error {
	constructor(
		readonly step: R2SetupStepId,
		message: string,
		readonly extra: Partial<R2SetupFailure> = {},
	) {
		super(message);
	}
}

/** A Cloudflare refusal at a step, in plain words: the permission to add, a taken name, or Cloudflare's message. */
function stepErrorOf(error: unknown, step: R2SetupStepId): StepError {
	if (error instanceof StepError) return error;
	if (error instanceof R2ApiError) {
		if (error.timedOut) return new StepError(error.step, TOO_LONG, { code: "timeout" });
		if (isPermissionRefusal(error))
			return new StepError(error.step, permissionMessage(error.step), {
				code: "permission",
				permission: permissionForStep(error.step) ?? undefined,
			});
		return new StepError(error.step, `Cloudflare answered: ${error.message}`);
	}
	return new StepError(step, error instanceof Error ? error.message.slice(0, 200) : "The step failed.");
}

type SetupTiming = { attempts: number; delayMs: number; sleep: (ms: number) => Promise<void> };

const DEFAULT_TIMING: SetupTiming = {
	attempts: 12,
	delayMs: 1500,
	sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

const TOO_LONG = "Setting up direct uploads took too long. Try again in a minute.";

/**
 * The time budget of one setup. Steps start only before `steps`; whatever happens, the cleanup after a failure
 * (deleting the token, restoring CORS) gets its own few seconds, so it always runs inside the request.
 */
class Budget {
	readonly steps: number;

	constructor(totalMs: number) {
		this.steps = Date.now() + totalMs - CLEANUP_RESERVE_MS;
	}

	left(): number {
		return this.steps - Date.now();
	}

	/** Refuses to start a step that needs more time than is left. */
	start(step: R2SetupStepId, needMs = 1_000): CallLimits {
		if (this.left() < needMs) throw new StepError(step, TOO_LONG, { code: "timeout" });
		return { deadline: this.steps };
	}

	/** Cleanup gets its own short window, even past the step deadline. */
	cleanup(): CallLimits {
		return { deadline: Date.now() + CLEANUP_RESERVE_MS };
	}
}

const CLEANUP_RESERVE_MS = 5_000;
/** Creating a token is the one call whose effect must be known, so it only starts with time to finish. */
const TOKEN_STEP_MS = 5_000;

/** A new R2 token takes a few seconds to work; HeadBucket is retried until it does, within the budget. */
async function waitForKeys(bucket: S3Bucket, timing: SetupTiming, budget: Budget): Promise<void> {
	for (let attempt = 1; attempt <= timing.attempts; attempt++) {
		budget.start("keys");
		try {
			await bucket.headBucket();
			return;
		} catch {
			if (attempt === timing.attempts || budget.left() <= timing.delayMs + 1_000) break;
			await timing.sleep(timing.delayMs);
		}
	}
	throw new StepError(
		"keys",
		budget.left() <= timing.delayMs + 1_000 ? TOO_LONG : "The new keys did not start working. Try again in a minute.",
		budget.left() <= timing.delayMs + 1_000 ? { code: "timeout" } : {},
	);
}

/**
 * The keys sign for the bucket the Worker's `BUCKET` binding writes to, or direct uploads would land elsewhere.
 * @public Exercised by the unit tests.
 */
export async function checkBindingBucket(env: CloudflareEnv, bucket: S3Bucket, name: string): Promise<void> {
	const binding = rawEnvOf(env).BUCKET;
	const probe = probeKey("binding");
	await binding.put(probe, "kite binding check");
	try {
		if (!(await bucket.head(probe)))
			throw new StepError(
				"binding",
				`The Worker's bucket is not ${name}. Pick the bucket bound as BUCKET in wrangler.jsonc.`,
			);
	} finally {
		await binding.delete(probe).catch(() => undefined);
	}
}

export type R2SetupPlan = {
	/** Direct uploads for the default store (the binding's bucket) rather than a store of its own. */
	sameAsBinding: boolean;
	bucket: string;
	jurisdiction: R2Jurisdiction;
	/** Create the bucket first; without it the bucket must exist. */
	create?: { locationHint?: string } | null;
	name?: string;
};

type Context = {
	env: CloudflareEnv;
	actor: { id: string };
	origin: string;
	timing: SetupTiming;
	budget: Budget;
	/** Eight characters of the attempt's id, which make the token's name unique to this attempt. */
	attemptTag: string;
};

function storeForm(env: CloudflareEnv, plan: R2SetupPlan, accountId: string, credentials: S3Credentials) {
	return {
		name: plan.name?.trim() || (plan.sameAsBinding ? "Cloudflare R2 direct uploads" : `Cloudflare R2 ${plan.bucket}`),
		provider: "r2",
		endpoint: r2S3Endpoint(env, accountId, plan.jurisdiction),
		region: "auto",
		bucket: plan.bucket,
		addressing: "path",
		sameAsBinding: plan.sameAsBinding,
		...credentials,
	};
}

/**
 * Tokens outlive stores, so a second token for a bucket Kite already uses is refused before one is made: the existing
 * store is edited (or deleted, with its token in the Cloudflare dashboard) instead. Any R2 store on the same bucket
 * and endpoint host counts (a separate one-click store too), and direct uploads also refuse while they have keys.
 */
async function refuseDuplicate(env: CloudflareEnv, plan: R2SetupPlan, accountId: string): Promise<void> {
	const stores = [...(await readStorageConfig(env)).stores.values()];
	const refuse = (message: string) => new StepError("bucket", message, { code: "already_connected", status: 409 });
	if (plan.sameAsBinding && stores.some((store) => store.sameAsBinding))
		throw refuse("Direct uploads already have keys; edit that store instead.");
	const host = new URL(r2S3Endpoint(env, accountId, plan.jurisdiction)).host;
	const same = stores.find(
		(store) => store.provider === "r2" && store.location.bucket === plan.bucket && store.location.endpoint === host,
	);
	if (same) throw refuse(`Kite already has a store for ${plan.bucket} (${same.name}); edit or delete it first.`);
}

async function ensureBucket(ctx: Context, accountId: string, plan: R2SetupPlan): Promise<string> {
	const limits = ctx.budget.start("bucket");
	if (plan.create) {
		try {
			await createR2Bucket(
				ctx.env,
				accountId,
				{ name: plan.bucket, jurisdiction: plan.jurisdiction, ...plan.create },
				limits,
			);
			return `Created ${plan.bucket}`;
		} catch (error) {
			if (error instanceof R2ApiError && !isPermissionRefusal(error) && isBucketExists(error))
				throw new StepError("bucket", `A bucket named ${plan.bucket} already exists in this account.`, {
					code: "bucket_exists",
					status: 409,
				});
			throw error;
		}
	}
	const buckets = await listR2Buckets(ctx.env, accountId, plan.jurisdiction, limits);
	if (!buckets.some((bucket) => bucket.name === plan.bucket))
		throw new StepError(
			"bucket",
			`There is no bucket named ${plan.bucket} in this account${plan.jurisdiction ? ` (${plan.jurisdiction})` : ""}.`,
		);
	return `Using ${plan.bucket}`;
}

/**
 * The token for the bucket. When the create request was sent but got no answer in time, Cloudflare may still have
 * made it, so the token with this attempt's own name is deleted; a timeout before the request left deletes nothing.
 */
async function createToken(ctx: Context, plan: R2SetupPlan, accountId: string): Promise<S3Credentials> {
	const limits = ctx.budget.start("token", TOKEN_STEP_MS);
	const name = r2TokenName(plan.bucket, plan.jurisdiction, ctx.attemptTag);
	let sent = false;
	try {
		return await createR2BucketToken(ctx.env, accountId, plan.bucket, plan.jurisdiction, {
			name,
			limits,
			onSend: () => {
				sent = true;
			},
		});
	} catch (error) {
		if (sent && error instanceof R2ApiError && error.timedOut)
			await deleteR2TokenNamed(ctx.env, accountId, name, ctx.budget.cleanup());
		throw stepErrorOf(error, "token");
	}
}

/** Steps 3 to 7, with the token deleted and the CORS policy restored when a later step fails or time runs out. */
async function connectBucket(
	ctx: Context,
	progress: Progress,
	plan: R2SetupPlan,
	accountId: string,
): Promise<R2SetupResult> {
	const { env, budget } = ctx;
	let step: R2SetupStepId = "token";
	let previousCors: R2CorsRule[] | null = null;
	const credentials = await createToken(ctx, plan, accountId);
	progress.ok("token", "Object Read & Write on this bucket only");
	try {
		step = "cors";
		previousCors = await setR2BucketCors(
			env,
			accountId,
			plan.bucket,
			plan.jurisdiction,
			corsOrigins(ctx.origin, env.APP_URL),
			budget.start("cors"),
		);
		progress.ok("cors");
		const form = storeForm(env, plan, accountId, credentials);
		const parsed = parseStoreInput(form);
		if (!parsed.ok) throw new StepError("checks", parsed.error);
		const bucket = new S3Bucket(
			{ ...parsed.value.location, ...credentials },
			{ timeoutMs: () => Math.max(1_000, Math.min(10_000, budget.left())) },
		);
		step = "keys";
		await waitForKeys(bucket, ctx.timing, budget);
		progress.ok("keys");
		if (plan.sameAsBinding && !r2S3TestEndpoint(env)) {
			step = "binding";
			budget.start("binding");
			await checkBindingBucket(env, bucket, plan.bucket);
			progress.ok("binding");
		}
		step = "checks";
		budget.start("checks", 3_000);
		const saved = await createStore(env, ctx.actor, form, ctx.origin, { deadline: budget.steps });
		if (!saved.ok)
			throw new StepError("checks", saved.error, { code: "checks_failed", report: saved.report, status: saved.status });
		progress.ok("checks");
		return { ok: true, steps: progress.steps, store: saved.store, report: saved.report };
	} catch (error) {
		const limits = budget.cleanup();
		await Promise.all([
			deleteR2Token(env, accountId, credentials.accessKeyId, limits),
			// The bucket's other sites keep the CORS policy they had before this attempt.
			previousCors
				? restoreR2BucketCors(env, accountId, plan.bucket, plan.jurisdiction, previousCors, limits)
				: Promise.resolve(),
		]);
		throw stepErrorOf(error, step);
	}
}

const PLAN: R2SetupStepId[] = ["account", "bucket", "token", "cors", "keys", "binding", "checks"];

async function runSetup(ctx: Context, plan: R2SetupPlan): Promise<R2SetupResult> {
	const progress = new Progress(plan.sameAsBinding ? PLAN : PLAN.filter((id) => id !== "binding"));
	let step: R2SetupStepId = "account";
	try {
		const accountId = await resolveR2Account(ctx.env, await knownZoneIds(ctx.env), ctx.budget.start("account"));
		progress.ok("account");
		step = "bucket";
		await refuseDuplicate(ctx.env, plan, accountId);
		progress.ok("bucket", await ensureBucket(ctx, accountId, plan));
		return await connectBucket(ctx, progress, plan, accountId);
	} catch (error) {
		const failure = stepErrorOf(error, step);
		const steps = progress.fail(failure.step, failure.message);
		return { ok: false, status: 502, error: failure.message, steps, ...failure.extra };
	}
}

export type SetupOptions = {
	timing?: SetupTiming;
	/** The whole setup's time budget, cleanup included (60 seconds; 45 at install). */
	budgetMs?: number;
	source?: DirectUploadsSetupRecord["source"];
	/** The attempt's audit row (from `recordStorageAttempt`), which gets the outcome; else a new row is written. */
	attemptId?: string;
};

async function auditOutcome(
	env: CloudflareEnv,
	actor: { id: string },
	plan: R2SetupPlan,
	result: R2SetupResult,
	attemptId?: string,
) {
	const failed = result.ok ? null : result.steps.find((step) => step.status === "failed");
	const metadata = {
		kind: plan.sameAsBinding ? "direct_uploads" : "store",
		bucket: plan.bucket,
		jurisdiction: plan.jurisdiction || "default",
		created: !!plan.create,
		outcome: result.ok ? "set_up" : "failed",
		...(failed ? { failedStep: failed.id } : {}),
		...(!result.ok && result.code ? { code: result.code } : {}),
		...(!result.ok && result.permission ? { permission: result.permission } : {}),
		...(result.ok ? { storeId: result.store.id } : {}),
	};
	log.info("storage.auto_setup", metadata);
	if (attemptId) await completeStorageAttempt(env, attemptId, metadata);
	else await createAuditLog(env, { actorUserId: actor.id, action: "storage.auto_setup", metadata });
}

/** The audit row and the direct-uploads note; once the store is saved, a failure here is logged, never answered. */
async function recordOutcome(
	env: CloudflareEnv,
	actor: { id: string },
	plan: R2SetupPlan,
	result: R2SetupResult,
	options: SetupOptions,
): Promise<void> {
	const failed = result.ok ? null : result.steps.find((step) => step.status === "failed");
	try {
		await auditOutcome(env, actor, plan, result, options.attemptId);
		if (plan.sameAsBinding)
			await recordDirectUploadsSetup(env, {
				ok: result.ok,
				at: new Date().toISOString(),
				source: options.source ?? "admin",
				...(result.ok ? {} : { step: failed?.id, message: result.error }),
				...(!result.ok && result.permission ? { permission: result.permission } : {}),
			});
	} catch (error) {
		log.error("storage.auto_setup_record_failed", { error, ok: result.ok });
	}
}

const ADMIN_BUDGET_MS = 60_000;

/** The last eight letters and digits of the attempt's audit row id, or of a fresh id when there is none. */
function attemptTagOf(attemptId?: string): string {
	return (attemptId ?? crypto.randomUUID()).replace(/[^A-Za-z0-9]/g, "").slice(-8);
}

/**
 * One click from Admin → Storage, and first-run setup: an R2 bucket (created, or an existing one) connected with a
 * token that may only use that bucket, its CORS rule set for this site, and the store checked and saved like a
 * manual entry, all within a time budget that keeps the cleanup inside the request. The token value is never
 * returned, stored or logged; the audit row names the bucket and outcome.
 */
export async function setUpR2(
	env: CloudflareEnv,
	actor: { id: string },
	origin: string,
	plan: R2SetupPlan,
	options: SetupOptions = {},
): Promise<R2SetupResult> {
	const availability = await r2AutoSetupAvailability(env);
	const budget = new Budget(options.budgetMs ?? ADMIN_BUDGET_MS);
	const attemptTag = attemptTagOf(options.attemptId);
	const result: R2SetupResult = availability.available
		? await runSetup({ env, actor, origin, timing: options.timing ?? DEFAULT_TIMING, budget, attemptTag }, plan)
		: { ok: false, status: 409, error: availability.reason ?? "Not available", steps: [], code: "unavailable" };
	await recordOutcome(env, actor, plan, result, options);
	return result;
}

/** Direct uploads for the default bucket, as first-run setup and the one-click button run it. */
export function setUpDirectUploads(
	env: CloudflareEnv,
	actor: { id: string },
	origin: string,
	input: { bucket?: string; jurisdiction?: R2Jurisdiction } = {},
	options?: SetupOptions,
): Promise<R2SetupResult> {
	return setUpR2(
		env,
		actor,
		origin,
		{ sameAsBinding: true, bucket: input.bucket || DEFAULT_BINDING_BUCKET, jurisdiction: input.jurisdiction ?? "" },
		options,
	);
}

const INSTALL_BUDGET_MS = 45_000;

/**
 * First-run setup on Cloudflare: direct uploads are on by default, so registration sets them up with the setup's
 * Cloudflare credentials. It never fails registration and nothing runs after the response: the setup's own budget
 * (45 seconds, cleanup included) ends it, and a refusal or timeout is recorded for the Storage page and the Admin
 * overview to offer the one-click and guided setup. Off Workers (local files) there is nothing to set up.
 */
export async function setUpDirectUploadsAtInstall(
	env: CloudflareEnv,
	actor: { id: string },
	origin: string,
	options: Pick<SetupOptions, "timing" | "budgetMs"> = {},
): Promise<{ ok: boolean; message?: string } | null> {
	if (isNodeRuntime(env) && !r2ApiTestOrigin(env)) return null;
	try {
		const result = await setUpDirectUploads(
			env,
			actor,
			origin,
			{},
			{
				budgetMs: INSTALL_BUDGET_MS,
				...options,
				source: "install",
			},
		);
		return { ok: result.ok, ...(result.ok ? {} : { message: result.error }) };
	} catch (error) {
		log.warn("storage.direct_uploads_install_failed", { error });
		await recordDirectUploadsSetup(env, {
			ok: false,
			at: new Date().toISOString(),
			source: "install",
			message: "Direct uploads could not be set up during installation.",
		}).catch(() => undefined);
		return { ok: false, message: "Direct uploads could not be set up during installation." };
	}
}
