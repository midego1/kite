import type { S3Provider } from "./types";

export type ValidationStepId =
	| "endpoint"
	| "bucket"
	| "write"
	| "read"
	| "delete"
	| "multipart"
	| "presign"
	| "cors_preflight"
	| "cors_upload"
	| "lifecycle";

export type ValidationStep = {
	id: ValidationStepId;
	label: string;
	status: "ok" | "failed" | "skipped" | "advice";
	/** What went wrong, in plain words; never a URL, a signature or a credential. */
	detail?: string;
	/** How to fix it: the permission, the policy or the setting. */
	fix?: string;
};

export type ValidationReport = {
	/** Every required step passed, so the store may be saved and routed to (for Drive, CORS must pass too). */
	ok: boolean;
	/** Both CORS steps passed, so browsers can upload to the store directly. */
	cors: boolean;
	steps: ValidationStep[];
};

export const STEP_LABELS: Record<ValidationStepId, string> = {
	endpoint: "Endpoint is allowed",
	bucket: "Bucket exists and the key can use it",
	write: "Write a test object",
	read: "Read it back",
	delete: "Delete it",
	multipart: "Start and cancel a multipart upload",
	presign: "Open a signed link",
	cors_preflight: "Browser upload preflight (CORS)",
	cors_upload: "Browser upload response (CORS)",
	lifecycle: "Clean up abandoned uploads",
};

/**
 * The steps a store must pass to be saved; CORS only blocks routing Drive to it.
 * @public Exercised by the unit tests.
 */
export const REQUIRED_STEPS: readonly ValidationStepId[] = [
	"endpoint",
	"bucket",
	"write",
	"read",
	"delete",
	"multipart",
	"presign",
];

/**
 * The permissions Kite uses, as an IAM-style policy an admin can attach (the pattern of `AWS_IAM_POLICY`).
 * @public Exercised by the unit tests.
 */
export function storePolicy(bucket: string) {
	return {
		Version: "2012-10-17",
		Statement: [
			{ Effect: "Allow", Action: ["s3:ListBucket"], Resource: [`arn:aws:s3:::${bucket}`] },
			{
				Effect: "Allow",
				Action: [
					"s3:GetObject",
					"s3:PutObject",
					"s3:DeleteObject",
					"s3:AbortMultipartUpload",
					"s3:ListMultipartUploadParts",
				],
				Resource: [`arn:aws:s3:::${bucket}/*`],
			},
		],
	};
}

const PERMISSION_FOR: Partial<Record<ValidationStepId, string>> = {
	bucket: "s3:ListBucket",
	write: "s3:PutObject",
	read: "s3:GetObject",
	delete: "s3:DeleteObject",
	multipart: "s3:PutObject and s3:AbortMultipartUpload",
	presign: "s3:GetObject",
};

type FailureShape = { status?: number; code?: string; message?: string; network?: boolean };

/** Turns a failed request into what went wrong and how to fix it, by the S3 error code. */
export function describeFailure(step: ValidationStepId, failure: FailureShape): Pick<ValidationStep, "detail" | "fix"> {
	const code = failure.code ?? "";
	if (failure.network)
		return {
			detail: "Could not reach the endpoint.",
			fix: "Check the endpoint host and port, and that the store is reachable from the server.",
		};
	if (/SignatureDoesNotMatch/i.test(code))
		return {
			detail: "The store rejected the signature.",
			fix: "Check the secret access key, and that the region matches the bucket's region.",
		};
	if (/InvalidAccessKeyId|InvalidClientTokenId|UnrecognizedClient/i.test(code))
		return { detail: "The store does not know this access key ID.", fix: "Check the access key ID." };
	if (/RequestTimeTooSkewed|RequestExpired/i.test(code) || /expired/i.test(failure.message ?? ""))
		return {
			detail: "The store refused a signed request as expired.",
			fix: "The server clock and the store's clock differ; check the server's time.",
		};
	if (/NoSuchBucket/i.test(code) || (step === "bucket" && failure.status === 404))
		return { detail: "The bucket does not exist.", fix: "Check the bucket name, or create the bucket first." };
	if (/PermanentRedirect|AuthorizationHeaderMalformed|IllegalLocationConstraint/i.test(code) || failure.status === 301)
		return {
			detail: "The bucket is in another region or needs another endpoint.",
			fix: "Use the bucket's own region and endpoint.",
		};
	if (/AccessDenied|Forbidden/i.test(code) || failure.status === 403)
		return {
			detail: "The key is not allowed to do this.",
			fix: PERMISSION_FOR[step]
				? `Grant ${PERMISSION_FOR[step]} on the bucket.`
				: "Grant the permissions in the policy below.",
		};
	return {
		detail: failure.message ? `The store answered: ${failure.message.slice(0, 200)}` : "The request failed.",
		fix: PERMISSION_FOR[step] ? `Check that the key has ${PERMISSION_FOR[step]}.` : undefined,
	};
}

const headerList = (value: string | null) =>
	(value ?? "")
		.split(",")
		.map((part) => part.trim().toLowerCase())
		.filter(Boolean);

/** The CORS preflight answer direct uploads need, or what is missing from it. */
export function preflightProblem(headers: Headers, status: number, origin: string): string | null {
	const allowOrigin = headers.get("access-control-allow-origin");
	if (status >= 400 || !allowOrigin) return "The store did not allow uploads from this site.";
	if (allowOrigin !== "*" && allowOrigin !== origin) return `The store allows ${allowOrigin}, not ${origin}.`;
	if (!headerList(headers.get("access-control-allow-methods")).includes("put")) return "PUT is not an allowed method.";
	const allowedHeaders = headerList(headers.get("access-control-allow-headers"));
	if (!allowedHeaders.includes("content-type") && !allowedHeaders.includes("*"))
		return "The Content-Type header is not allowed.";
	return null;
}

/** Browsers apply Expose-Headers to the actual response only, and the upload reads each part's ETag. */
export function uploadResponseProblem(headers: Headers, origin: string): string | null {
	const allowOrigin = headers.get("access-control-allow-origin");
	if (!allowOrigin || (allowOrigin !== "*" && allowOrigin !== origin))
		return "The upload response does not allow this site.";
	const exposed = headerList(headers.get("access-control-expose-headers"));
	if (!exposed.includes("etag") && !exposed.includes("*"))
		return "The upload response does not expose the ETag header.";
	return null;
}

/** Where to set the CORS rule when Kite cannot set it itself. */
export function corsFix(provider: S3Provider, canApply: boolean): string {
	if (canApply) return "Use Apply CORS, or add the rule below to the bucket.";
	if (provider === "b2") return "Add the rule below with the B2 CLI (b2 bucket update --cors-rules) or the B2 console.";
	return "Add the rule below in the provider's console or CLI.";
}

export function reportFrom(steps: ValidationStep[]): ValidationReport {
	const passed = (id: ValidationStepId) => steps.some((step) => step.id === id && step.status === "ok");
	return {
		ok: REQUIRED_STEPS.every(passed),
		cors: passed("cors_preflight") && passed("cors_upload"),
		steps,
	};
}

/** The first failing step, short enough for `storage_stores.last_error`. */
export function reportSummary(report: ValidationReport): string | null {
	const failed = report.steps.find((step) => step.status === "failed" && REQUIRED_STEPS.includes(step.id));
	return failed ? `${failed.label}: ${failed.detail ?? "failed"}`.slice(0, 300) : null;
}
