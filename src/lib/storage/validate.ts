import { AwsError } from "@/lib/aws/client";
import { assertStoreEndpoint, type StorageEnv } from "./config";
import { probeKey, StorageTestError, testStorage } from "./health";
import { S3Bucket } from "./s3-bucket";
import { presetFor } from "./s3-presets-utils";
import type { KiteBucket, S3Credentials, S3Location, S3Provider } from "./types";
import {
	bucketFailureStep,
	corsFix,
	describeFailure,
	preflightProblem,
	reportFrom,
	STEP_LABELS,
	uploadResponseProblem,
	type ValidationReport,
	type ValidationStep,
	type HintContext,
	type ValidationStepId,
} from "./validate-utils";

export type StoreCandidate = { provider: S3Provider; location: S3Location; credentials: S3Credentials };

const PROBE_SECONDS = 60;

function failureOf(error: unknown) {
	const cause = error instanceof StorageTestError ? error.cause : error;
	if (cause instanceof AwsError) return { status: cause.status, code: cause.code, message: cause.message };
	if (cause instanceof TypeError) return { network: true };
	return { message: cause instanceof Error ? cause.message : undefined };
}

class Steps {
	readonly list: ValidationStep[] = [];

	constructor(private readonly context?: HintContext) {}

	ok(id: ValidationStepId, detail?: string) {
		this.list.push({ id, label: STEP_LABELS[id], status: "ok", ...(detail ? { detail } : {}) });
	}

	failed(id: ValidationStepId, error: unknown) {
		this.list.push({
			id,
			label: STEP_LABELS[id],
			status: "failed",
			...describeFailure(id, failureOf(error), this.context),
		});
	}

	problem(id: ValidationStepId, detail: string, fix?: string) {
		this.list.push({ id, label: STEP_LABELS[id], status: "failed", detail, ...(fix ? { fix } : {}) });
	}

	advice(id: ValidationStepId, detail: string, fix?: string) {
		this.list.push({ id, label: STEP_LABELS[id], status: "advice", detail, ...(fix ? { fix } : {}) });
	}

	skip(...ids: ValidationStepId[]) {
		for (const id of ids)
			if (!this.list.some((step) => step.id === id)) this.list.push({ id, label: STEP_LABELS[id], status: "skipped" });
	}

	async run(id: ValidationStepId, check: () => Promise<void>): Promise<boolean> {
		try {
			await check();
			this.ok(id);
			return true;
		} catch (error) {
			this.failed(id, error);
			return false;
		}
	}
}

const AFTER_BUCKET: ValidationStepId[] = [
	"write",
	"read",
	"list",
	"presign",
	"delete",
	"multipart",
	"cors_preflight",
	"cors_upload",
	"lifecycle",
];

/**
 * HeadBucket answers errors without a body, so a 403 cannot tell a wrong secret from a missing permission. A
 * one-key listing then returns the store's error code, which names the actual problem.
 */
async function checkBucket(bucket: S3Bucket): Promise<void> {
	try {
		await bucket.headBucket();
	} catch (error) {
		if (!(error instanceof AwsError) || error.status !== 403) throw error;
		const precise = await bucket.list({ limit: 1 }).then(
			() => null,
			(listError: unknown) => listError,
		);
		throw precise instanceof AwsError && precise.code && !/^HTTP\d+$/.test(precise.code) ? precise : error;
	}
}

/** One bucket request answers three steps: whether the endpoint answers, the key is accepted and the bucket is usable. */
async function reachBucket(steps: Steps, bucket: S3Bucket): Promise<boolean> {
	try {
		await checkBucket(bucket);
	} catch (error) {
		const at = bucketFailureStep(failureOf(error));
		if (at !== "endpoint") steps.ok("endpoint");
		if (at === "bucket") steps.ok("credentials");
		steps.failed(at, error);
		return false;
	}
	steps.ok("endpoint");
	steps.ok("credentials");
	steps.ok("bucket");
	return true;
}

async function checkObjects(steps: Steps, bucket: S3Bucket): Promise<void> {
	let probe: string;
	try {
		probe = (await testStorage(bucket as unknown as KiteBucket, { keep: true })).key;
		steps.ok("write");
		steps.ok("read");
	} catch (error) {
		steps.failed(error instanceof StorageTestError ? error.step : "write", error);
		return;
	}
	await steps.run("list", async () => {
		await bucket.list({ prefix: "healthcheck/", limit: 1 });
	});
	await steps.run("presign", async () => {
		const url = await bucket.signer.presignGet(probe, {
			expiresIn: PROBE_SECONDS,
			filename: "kite-check.txt",
			disposition: "attachment",
			contentType: "text/plain",
		});
		const response = await fetch(url);
		if (!response.ok) {
			const text = await response.text().catch(() => "");
			const code = /<Code>([^<]+)<\/Code>/.exec(text)?.[1] ?? `HTTP${response.status}`;
			const message = /<Message>([^<]+)<\/Message>/.exec(text)?.[1];
			throw new AwsError(message ?? "The signed link was refused", response.status, code);
		}
		await response.body?.cancel();
	});
	await steps.run("delete", () => bucket.delete(probe));
}

async function checkCors(steps: Steps, bucket: S3Bucket, provider: S3Provider, appOrigin: string): Promise<void> {
	const fix = corsFix(provider, !!presetFor(provider)?.applyCors);
	const probe = probeKey("cors");
	try {
		const preflight = await fetch(bucket.objectUrl(probe), {
			method: "OPTIONS",
			headers: {
				Origin: appOrigin,
				"Access-Control-Request-Method": "PUT",
				"Access-Control-Request-Headers": "content-type",
			},
		});
		await preflight.body?.cancel();
		const problem = preflightProblem(preflight.headers, preflight.status, appOrigin);
		if (problem) steps.problem("cors_preflight", problem, fix);
		else steps.ok("cors_preflight");
	} catch (error) {
		steps.failed("cors_preflight", error);
	}
	const body = "kite cors check";
	try {
		const url = await bucket.signer.presignPut(probe, {
			expiresIn: PROBE_SECONDS,
			contentLength: body.length,
			contentType: "text/plain",
		});
		const upload = await fetch(url, {
			method: "PUT",
			headers: { Origin: appOrigin, "Content-Type": "text/plain" },
			body,
		});
		await upload.body?.cancel();
		if (!upload.ok) throw new AwsError("The signed upload was refused", upload.status, `HTTP${upload.status}`);
		const problem = uploadResponseProblem(upload.headers, appOrigin);
		if (problem) steps.problem("cors_upload", problem, fix);
		else steps.ok("cors_upload");
	} catch (error) {
		steps.failed("cors_upload", error);
	} finally {
		await bucket.delete(probe).catch(() => undefined);
	}
}

function lifecycleAdvice(steps: Steps, provider: S3Provider) {
	if (provider === "r2") return steps.ok("lifecycle", "R2 cancels unfinished uploads after 7 days by default.");
	const preset = presetFor(provider);
	steps.advice(
		"lifecycle",
		"Unfinished multipart uploads keep using space until they are cancelled.",
		preset?.applyLifecycle
			? "Use Add lifecycle rule to cancel them after 7 days."
			: "Add a lifecycle rule that aborts incomplete multipart uploads after 7 days.",
	);
}

/**
 * The checklist a store must pass before it is saved, and again from the Test button (spec 4.5). Each step is
 * reported with the permission or setting that fixes it. Probe objects live under `healthcheck/` and are deleted
 * again; nothing in the report carries a URL, a signature or a credential.
 */
export async function validateStore(
	env: StorageEnv,
	candidate: StoreCandidate,
	appOrigin: string,
): Promise<ValidationReport> {
	const steps = new Steps({ provider: candidate.provider, bucket: candidate.location.bucket });
	try {
		await assertStoreEndpoint(env, candidate.location);
	} catch (error) {
		steps.problem("endpoint", error instanceof Error ? error.message : "The endpoint is not allowed");
		steps.skip("credentials", "bucket", ...AFTER_BUCKET);
		return reportFrom(steps.list);
	}
	const bucket = new S3Bucket({ ...candidate.location, ...candidate.credentials });
	if (!(await reachBucket(steps, bucket))) {
		steps.skip("endpoint", "credentials", "bucket", ...AFTER_BUCKET);
		return reportFrom(steps.list);
	}
	await checkObjects(steps, bucket);
	await steps.run("multipart", async () => {
		const upload = await bucket.createMultipartUpload(probeKey("multipart"));
		await upload.abort();
	});
	await checkCors(steps, bucket, candidate.provider, appOrigin);
	lifecycleAdvice(steps, candidate.provider);
	steps.skip(...AFTER_BUCKET);
	const order = Object.keys(STEP_LABELS);
	steps.list.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
	return reportFrom(steps.list);
}

/** Only the two CORS steps, for routing Drive to a store that passed the rest recently. */
export async function validateStoreCors(
	candidate: StoreCandidate,
	appOrigin: string,
): Promise<{ ok: boolean; steps: ValidationStep[] }> {
	const steps = new Steps({ provider: candidate.provider, bucket: candidate.location.bucket });
	await checkCors(
		steps,
		new S3Bucket({ ...candidate.location, ...candidate.credentials }),
		candidate.provider,
		appOrigin,
	);
	return { ok: steps.list.every((step) => step.status === "ok"), steps: steps.list };
}
