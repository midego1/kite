import type { CfApiError } from "@/lib/cloudflare-api.types";
import { getCloudflareAuth, getCloudflareAuthHeaders } from "@/lib/cloudflare-api-utils";
import { isNodeRuntime } from "@/lib/runtime";
import {
	bucketTokenBody,
	loopbackTestOrigin,
	R2_BUCKET_ITEM_WRITE,
	r2BucketResource,
	r2CorsBody,
	r2Endpoint,
	type R2CorsRule,
	type R2Jurisdiction,
	type R2SetupStepId,
} from "./cloudflare-r2-utils";
import type { S3Credentials } from "./types";

const API = "https://api.cloudflare.com/client/v4";
const REQUEST_TIMEOUT_MS = 15_000;

/** A refused or failed Cloudflare API call, with the setup step it belongs to. Never carries a token. */
export class R2ApiError extends Error {
	constructor(
		readonly step: R2SetupStepId,
		readonly status: number,
		readonly codes: number[],
		message: string,
		/** No answer in time: the call may still have taken effect at Cloudflare. */
		readonly timedOut = false,
	) {
		super(message);
	}
}

/** A deadline (epoch milliseconds) that caps each call's own timeout; past it, no call is made. */
export type CallLimits = { deadline?: number };

const MIN_CALL_MS = 1_000;

function callTimeout(step: R2SetupStepId, limits: CallLimits): number {
	if (limits.deadline === undefined) return REQUEST_TIMEOUT_MS;
	const left = limits.deadline - Date.now();
	if (left < MIN_CALL_MS) throw new R2ApiError(step, 0, [], "There was no time left for this step.", true);
	return Math.min(REQUEST_TIMEOUT_MS, left);
}

export type R2Bucket = {
	name: string;
	jurisdiction: R2Jurisdiction;
	location: string | null;
	creationDate: string | null;
};

type Env = Pick<
	CloudflareEnv,
	"CF_TOKEN" | "CF_API_KEY" | "CF_EMAIL" | "CF_ACCOUNT_ID" | "CLOUDFLARE_API_TEST_ORIGIN" | "R2_S3_TEST_ENDPOINT"
> &
	Partial<Pick<CloudflareEnv, "KITE_RUNTIME">>;

/** The Cloudflare API stand-in in dev and tests; always null in production. */
export function r2ApiTestOrigin(env: Pick<CloudflareEnv, "CLOUDFLARE_API_TEST_ORIGIN">): string | null {
	return loopbackTestOrigin(env.CLOUDFLARE_API_TEST_ORIGIN, process.env.NODE_ENV);
}

/** The R2 S3 endpoint stand-in in dev and tests; always null in production. */
export function r2S3TestEndpoint(env: Pick<CloudflareEnv, "R2_S3_TEST_ENDPOINT">): string | null {
	return loopbackTestOrigin(env.R2_S3_TEST_ENDPOINT, process.env.NODE_ENV);
}

function testOrigin(env: Env): string | null {
	return loopbackTestOrigin(env.CLOUDFLARE_API_TEST_ORIGIN, process.env.NODE_ENV);
}

/** Whether Kite can call the Cloudflare API for R2 at all: on Workers, with `CF_TOKEN` (or the dev stand-in). */
export function r2ApiConfigured(env: Env): boolean {
	if (testOrigin(env)) return true;
	if (isNodeRuntime(env as CloudflareEnv)) return false;
	try {
		getCloudflareAuth(env as CloudflareEnv);
		return true;
	} catch {
		return false;
	}
}

/** The S3 endpoint the new keys sign for; the dev stand-in replaces R2's host in tests. */
export function r2S3Endpoint(env: Env, accountId: string, jurisdiction: R2Jurisdiction): string {
	return r2S3TestEndpoint(env) ?? r2Endpoint(accountId, jurisdiction);
}

function authHeaders(env: Env): HeadersInit {
	try {
		return getCloudflareAuthHeaders(getCloudflareAuth(env as CloudflareEnv));
	} catch (error) {
		if (testOrigin(env)) return { Authorization: "Bearer e2e-fake-cloudflare-token" };
		throw error;
	}
}

type Call = {
	method?: string;
	body?: unknown;
	jurisdiction?: R2Jurisdiction;
	query?: Record<string, string>;
	limits?: CallLimits;
};

function cfUrl(env: Env, path: string, query: Record<string, string> = {}): URL {
	const origin = testOrigin(env);
	const url = new URL(origin ? `${origin}/client/v4${path}` : `${API}${path}`);
	for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
	return url;
}

function cfHeaders(env: Env, jurisdiction: R2Jurisdiction | undefined): HeadersInit {
	return {
		...authHeaders(env),
		"Content-Type": "application/json",
		...(jurisdiction ? { "cf-r2-jurisdiction": jurisdiction } : {}),
	};
}

/**
 * One Cloudflare API request. Redirects are not followed and each call has a deadline. The error names the step and
 * Cloudflare's codes and messages, which never contain the token.
 */
async function cfCall<T>(
	env: Env,
	step: R2SetupStepId,
	path: string,
	call: Call = {},
): Promise<{ result: T; cursor: string }> {
	const url = cfUrl(env, path, call.query);
	const timeoutMs = callTimeout(step, call.limits ?? {});
	let response: Response;
	try {
		response = await fetch(url, {
			method: call.method ?? "GET",
			redirect: "manual",
			signal: AbortSignal.timeout(timeoutMs),
			headers: cfHeaders(env, call.jurisdiction),
			...(call.body === undefined ? {} : { body: JSON.stringify(call.body) }),
		});
	} catch (error) {
		const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
		throw new R2ApiError(step, 0, [], "Cloudflare's API did not answer in time.", timedOut);
	}
	const json = (await response.json().catch(() => null)) as {
		success?: boolean;
		result?: T;
		errors?: CfApiError[];
		result_info?: { cursor?: string };
	} | null;
	if (!response.ok || !json?.success) {
		const errors = json?.errors ?? [];
		const message = errors.map((error) => error.message).join("; ") || `Cloudflare answered ${response.status}.`;
		throw new R2ApiError(
			step,
			response.status,
			errors.map((error) => Number(error.code)).filter(Number.isFinite),
			message.slice(0, 300),
		);
	}
	return { result: json.result as T, cursor: json.result_info?.cursor ?? "" };
}

async function cf<T>(env: Env, step: R2SetupStepId, path: string, call: Call = {}): Promise<T> {
	return (await cfCall<T>(env, step, path, call)).result;
}

/**
 * The account Kite runs in: `CF_ACCOUNT_ID`, else the account of a zone Kite already manages (`GET /zones/{id}`,
 * which `Zone: Read` covers), else the one account the token can see (`GET /accounts`, which needs
 * `Account Settings: Read`).
 */
export async function resolveR2Account(env: Env, zoneIds: string[] = [], limits: CallLimits = {}): Promise<string> {
	const configured = env.CF_ACCOUNT_ID?.trim();
	if (configured) return configured;
	for (const zoneId of zoneIds.slice(0, 3)) {
		const zone = await cf<{ account?: { id?: string } }>(env, "account", `/zones/${encodeURIComponent(zoneId)}`, {
			limits,
		}).catch(() => null);
		if (zone?.account?.id) return zone.account.id;
	}
	const accounts = await cf<{ id: string }[]>(env, "account", "/accounts", { query: { per_page: "2" }, limits });
	if (accounts.length !== 1)
		throw new R2ApiError(
			"account",
			400,
			[],
			accounts.length
				? "CF_TOKEN can see more than one account; set CF_ACCOUNT_ID to the one Kite runs in."
				: "CF_TOKEN cannot see any account.",
		);
	return accounts[0].id;
}

type BucketRow = { name: string; jurisdiction?: string; location?: string; creation_date?: string };

const jurisdictionOf = (value: string | undefined): R2Jurisdiction =>
	value === "eu" || value === "fedramp" ? value : "";

const bucketOf = (row: BucketRow): R2Bucket => ({
	name: row.name,
	jurisdiction: jurisdictionOf(row.jurisdiction),
	location: row.location ?? null,
	creationDate: row.creation_date ?? null,
});

/** The account's buckets in one jurisdiction, at most 1,000 (five pages). */
export async function listR2Buckets(
	env: Env,
	accountId: string,
	jurisdiction: R2Jurisdiction = "",
	limits: CallLimits = {},
): Promise<R2Bucket[]> {
	const buckets: R2Bucket[] = [];
	let cursor = "";
	for (let page = 0; page < 5; page++) {
		const answer = await cfCall<{ buckets?: BucketRow[] }>(
			env,
			"bucket",
			`/accounts/${encodeURIComponent(accountId)}/r2/buckets`,
			{
				jurisdiction: jurisdiction || undefined,
				query: { per_page: "200", ...(cursor ? { cursor } : {}) },
				limits,
			},
		);
		buckets.push(...(answer.result?.buckets ?? []).map(bucketOf));
		cursor = answer.cursor;
		if (!cursor) break;
	}
	return buckets;
}

export async function createR2Bucket(
	env: Env,
	accountId: string,
	input: { name: string; jurisdiction: R2Jurisdiction; locationHint?: string },
	limits: CallLimits = {},
): Promise<void> {
	await cf(env, "bucket", `/accounts/${encodeURIComponent(accountId)}/r2/buckets`, {
		method: "POST",
		limits,
		jurisdiction: input.jurisdiction || undefined,
		body: { name: input.name, ...(input.locationHint ? { locationHint: input.locationHint } : {}) },
	});
}

const corsPath = (accountId: string, bucket: string) =>
	`/accounts/${encodeURIComponent(accountId)}/r2/buckets/${encodeURIComponent(bucket)}/cors`;

/** The bucket's CORS rules; a bucket without a policy answers 404 (code 10059), which reads as none. */
async function readR2BucketCors(
	env: Env,
	accountId: string,
	bucket: string,
	jurisdiction: R2Jurisdiction,
	limits: CallLimits,
): Promise<R2CorsRule[]> {
	try {
		const answer = await cf<{ rules?: R2CorsRule[] } | null>(env, "cors", corsPath(accountId, bucket), {
			jurisdiction: jurisdiction || undefined,
			limits,
		});
		return answer?.rules ?? [];
	} catch (error) {
		if (error instanceof R2ApiError && (error.status === 404 || error.codes.includes(10059))) return [];
		throw error;
	}
}

/**
 * Adds (or replaces) Kite's rule in the bucket's CORS policy and keeps every other rule. Answers the rules that were
 * there before, so a setup that fails later can put them back with `restoreR2BucketCors`.
 */
export async function setR2BucketCors(
	env: Env,
	accountId: string,
	bucket: string,
	jurisdiction: R2Jurisdiction,
	origins: string[],
	limits: CallLimits = {},
): Promise<R2CorsRule[]> {
	const previous = await readR2BucketCors(env, accountId, bucket, jurisdiction, limits);
	await cf(env, "cors", corsPath(accountId, bucket), {
		method: "PUT",
		limits,
		jurisdiction: jurisdiction || undefined,
		body: r2CorsBody(origins, previous),
	});
	return previous;
}

/** Puts the bucket's CORS policy back as it was before the setup (deleting it when there was none); best effort. */
export async function restoreR2BucketCors(
	env: Env,
	accountId: string,
	bucket: string,
	jurisdiction: R2Jurisdiction,
	previous: R2CorsRule[],
	limits: CallLimits = {},
): Promise<void> {
	await cf(env, "cors", corsPath(accountId, bucket), {
		jurisdiction: jurisdiction || undefined,
		limits,
		...(previous.length ? { method: "PUT", body: { rules: previous } } : { method: "DELETE" }),
	}).catch(() => undefined);
}

async function sha256Hex(value: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** The name every token Kite creates for a bucket carries, so a lost one can be found and deleted. */
const r2TokenName = (bucket: string) => `Kite direct uploads: ${bucket}`;

/**
 * An account-owned API token that can only read, write and list objects in this bucket, as S3 keys: the access
 * key ID is the token's id and the secret the SHA-256 of its value (Cloudflare's R2 token docs). The value itself
 * is never returned, stored or logged. A token Cloudflare reports without its value is deleted again at once.
 */
export async function createR2BucketToken(
	env: Env,
	accountId: string,
	bucket: string,
	jurisdiction: R2Jurisdiction,
	limits: CallLimits = {},
): Promise<S3Credentials> {
	const base = `/accounts/${encodeURIComponent(accountId)}/tokens`;
	const groups = await cf<{ id: string; name: string }[]>(env, "token", `${base}/permission_groups`, { limits });
	const group = groups.find((entry) => entry.name === R2_BUCKET_ITEM_WRITE);
	if (!group)
		throw new R2ApiError("token", 404, [], `Cloudflare did not list the "${R2_BUCKET_ITEM_WRITE}" permission.`);
	const created = await cf<{ id?: string; value?: string }>(env, "token", base, {
		method: "POST",
		limits,
		body: bucketTokenBody(r2TokenName(bucket), group.id, r2BucketResource(accountId, jurisdiction, bucket)),
	});
	if (created?.id && !created.value) await deleteR2Token(env, accountId, created.id, limits);
	if (!created?.id || !created.value)
		throw new R2ApiError("token", 502, [], "Cloudflare did not return the new token.");
	return { accessKeyId: created.id, secretAccessKey: await sha256Hex(created.value) };
}

/** Deletes a token this setup created, when a later step failed; best effort. */
export async function deleteR2Token(
	env: Env,
	accountId: string,
	tokenId: string,
	limits: CallLimits = {},
): Promise<void> {
	await cf(env, "token", `/accounts/${encodeURIComponent(accountId)}/tokens/${encodeURIComponent(tokenId)}`, {
		method: "DELETE",
		limits,
	}).catch(() => undefined);
}

/**
 * When creating the token got no answer in time, Cloudflare may still have made it: the account's tokens with Kite's
 * name for this bucket are deleted. A saved store never uses one (setup refuses a bucket Kite already has a store
 * for), so this only removes tokens nobody can use; best effort.
 */
export async function deleteR2TokensNamed(env: Env, accountId: string, bucket: string, limits: CallLimits = {}) {
	const base = `/accounts/${encodeURIComponent(accountId)}/tokens`;
	const tokens = await cf<{ id: string; name: string }[]>(env, "token", base, {
		query: { per_page: "50" },
		limits,
	}).catch(() => []);
	await Promise.all(
		tokens
			.filter((token) => token.name === r2TokenName(bucket))
			.map((token) => deleteR2Token(env, accountId, token.id, limits)),
	);
}
