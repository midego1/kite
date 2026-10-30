import type { RoutableClass } from "./types";

/**
 * Cloudflare R2 through the Cloudflare API (docs/specs/drive-storage.md): what the automatic setup creates and the
 * permissions it needs. Client-safe: no request is made here.
 */

/** The bucket the `BUCKET` binding uses in wrangler.jsonc, which the Deploy button creates. */
export const DEFAULT_BINDING_BUCKET = "kite-raw";

/** The permission group a bucket-scoped R2 token gets: read, write and list objects in that bucket only. */
export const R2_BUCKET_ITEM_WRITE = "Workers R2 Storage Bucket Item Write";

/** The account permissions `CF_TOKEN` needs for each step, as the Cloudflare dashboard names them. */
export const R2_PERMISSIONS = {
	account: "Account Settings: Read",
	buckets: "Workers R2 Storage: Edit",
	tokens: "Account API Tokens: Edit",
} as const;

export type R2Jurisdiction = "" | "eu" | "fedramp";

/** Location hints R2 accepts when a bucket is created; "" lets Cloudflare choose. */
export const R2_LOCATION_HINTS: readonly { value: string; label: string }[] = [
	{ value: "", label: "Automatic" },
	{ value: "weur", label: "Western Europe" },
	{ value: "eeur", label: "Eastern Europe" },
	{ value: "enam", label: "Eastern North America" },
	{ value: "wnam", label: "Western North America" },
	{ value: "apac", label: "Asia-Pacific" },
	{ value: "oc", label: "Oceania" },
];

/** @public Exercised by the unit tests. */
export function isR2LocationHint(value: unknown): value is string {
	return typeof value === "string" && R2_LOCATION_HINTS.some((hint) => hint.value === value);
}

/** @public Exercised by the unit tests. */
export function isR2Jurisdiction(value: unknown): value is R2Jurisdiction {
	return value === "" || value === "eu" || value === "fedramp";
}

/** R2 bucket names: 3 to 63 lowercase letters, digits and hyphens, starting and ending with a letter or digit. */
export function r2BucketNameProblem(name: string): string | null {
	if (!name) return "Enter a bucket name";
	if (name.length < 3 || name.length > 63) return "Use 3 to 63 characters";
	if (/[A-Z]/.test(name)) return "Use lowercase letters only";
	if (!/^[a-z0-9-]+$/.test(name)) return "Use only lowercase letters, digits and hyphens";
	if (!/^[a-z0-9].*[a-z0-9]$/.test(name)) return "Start and end with a letter or digit";
	return null;
}

/** `kite-drive`, `kite-backups`, `kite-mail`: a name that says what the bucket is for. */
export function suggestedBucketName(objectClass: RoutableClass): string {
	return `kite-${objectClass}`;
}

/** The resource a bucket-scoped token policy names (Cloudflare's R2 token docs). */
export function r2BucketResource(accountId: string, jurisdiction: R2Jurisdiction, bucket: string): string {
	return `com.cloudflare.edge.r2.bucket.${accountId}_${jurisdiction || "default"}_${bucket}`;
}

/** The S3 endpoint of an account's buckets in a jurisdiction. */
export function r2Endpoint(accountId: string, jurisdiction: R2Jurisdiction): string {
	return `https://${accountId}${jurisdiction ? `.${jurisdiction}` : ""}.r2.cloudflarestorage.com`;
}

/** The id of Kite's own CORS rule, so a later setup replaces it and leaves every other rule alone. */
const KITE_CORS_RULE_ID = "kite-direct-uploads";

export type R2CorsRule = { id?: string; [field: string]: unknown };

/**
 * The body of `PUT …/r2/buckets/{bucket}/cors`: the bucket's other rules (for other sites) as they were, plus the rule
 * direct uploads need, in the R2 API's own shape. The PUT replaces the whole policy, so nothing else may be dropped.
 */
export function r2CorsBody(origins: string[], existing: R2CorsRule[] = []) {
	return {
		rules: [
			...existing.filter((rule) => rule.id !== KITE_CORS_RULE_ID),
			{
				id: KITE_CORS_RULE_ID,
				allowed: { origins, methods: ["PUT", "GET", "HEAD"], headers: ["content-type"] },
				exposeHeaders: ["ETag"],
				maxAgeSeconds: 3600,
			},
		],
	};
}

/** An account-owned token that can only read, write and list objects in one bucket. */
export function bucketTokenBody(name: string, permissionGroupId: string, resource: string) {
	return {
		name,
		policies: [{ effect: "allow", resources: { [resource]: "*" }, permission_groups: [{ id: permissionGroupId }] }],
	};
}

export type R2SetupStepId = "account" | "bucket" | "token" | "cors" | "keys" | "binding" | "checks";

export const R2_SETUP_STEP_LABELS: Record<R2SetupStepId, string> = {
	account: "Find the Cloudflare account",
	bucket: "Find or create the bucket",
	token: "Create an API token for this bucket only",
	cors: "Allow uploads from this site (CORS)",
	keys: "Wait for the new keys to work",
	binding: "Match the Worker's bucket",
	checks: "Check the connection and save",
};

/** The permission a refused Cloudflare request at this step needs, or null when the step is not an API call. */
export function permissionForStep(step: R2SetupStepId): string | null {
	if (step === "account") return R2_PERMISSIONS.account;
	if (step === "bucket" || step === "cors") return R2_PERMISSIONS.buckets;
	if (step === "token") return R2_PERMISSIONS.tokens;
	return null;
}

type CfErrorShape = { status: number; codes: number[] };

/** Whether Cloudflare refused for lack of permission (as opposed to a bad request or an outage). */
export function isPermissionRefusal({ status, codes }: CfErrorShape): boolean {
	return status === 401 || status === 403 || codes.some((code) => code === 10000 || code === 9109 || code === 10001);
}

/** "The bucket you tried to create already exists" (R2 answers 409 with code 10004). */
export function isBucketExists({ status, codes }: CfErrorShape): boolean {
	return status === 409 || codes.includes(10004);
}

/** One line for a refusal: the permission to add to CF_TOKEN, and that the manual steps still work. */
export function permissionMessage(step: R2SetupStepId): string {
	const permission = permissionForStep(step);
	return permission
		? `CF_TOKEN may not do this. Add the account permission "${permission}" to it, or set up the keys by hand below.`
		: "This step failed. Try again, or set up the keys by hand below.";
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost"]);

/** Dev/test only: a loopback http origin standing in for a Cloudflare service, or null (always null in production). */
export function loopbackTestOrigin(value: string | undefined, nodeEnv: string | undefined): string | null {
	if (!value?.trim() || nodeEnv === "production") return null;
	try {
		const url = new URL(value.trim());
		return url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname) ? url.origin : null;
	} catch {
		return null;
	}
}

export type R2SetupInput = {
	bucket: string;
	jurisdiction: R2Jurisdiction;
	create: { locationHint?: string } | null;
	name?: string;
};

/** Reads the one-click request: an existing bucket (`create: false`) or a new one with an optional location. */
export function parseR2SetupInput(
	raw: unknown,
	{ requireBucket }: { requireBucket: boolean },
): { ok: true; value: R2SetupInput } | { ok: false; error: string; field?: string } {
	const body = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
	const bucket = typeof body.bucket === "string" ? body.bucket.trim() : "";
	if (bucket || requireBucket) {
		const problem = r2BucketNameProblem(bucket);
		if (problem) return { ok: false, error: problem, field: "bucket" };
	}
	const jurisdiction = body.jurisdiction ?? "";
	if (!isR2Jurisdiction(jurisdiction)) return { ok: false, error: "Choose a jurisdiction", field: "jurisdiction" };
	const locationHint = body.locationHint ?? "";
	if (!isR2LocationHint(locationHint)) return { ok: false, error: "Choose a location", field: "locationHint" };
	const name = typeof body.name === "string" ? body.name.trim() : "";
	if (name.length > 80) return { ok: false, error: "Use a name of up to 80 characters", field: "name" };
	return {
		ok: true,
		value: {
			bucket,
			jurisdiction,
			create: body.create === true ? (locationHint ? { locationHint } : {}) : null,
			...(name ? { name } : {}),
		},
	};
}
