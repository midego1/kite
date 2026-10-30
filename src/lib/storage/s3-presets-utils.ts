import type { S3Addressing, S3Provider } from "./types";

type RegionOption = { value: string; label: string };

export type S3Preset = {
	provider: S3Provider;
	label: string;
	/** The regions offered in the form; the admin can still type another one. */
	regions?: readonly RegionOption[];
	/** Where the provider's console creates the key pair, and what it calls the page. */
	tokenPage?: { url: string; label: string };
	/** The permission the key pair needs, in the provider's own words. */
	credentialsHelp: string;
	addressing: S3Addressing;
	/** Endpoint host for a region (and, for R2, the account id); null for a custom endpoint. */
	endpoint: ((input: { region: string; accountId?: string }) => string) | null;
	/** A fixed signing region, when the provider has one. */
	region?: string;
	/** Kite can set the CORS rule itself (PutBucketCors works with the bucket's own keys). */
	applyCors: boolean;
	/** Kite can add the abort-incomplete-uploads lifecycle rule; R2 already aborts after 7 days. */
	applyLifecycle: boolean;
};

const AWS_REGIONS: readonly RegionOption[] = [
	{ value: "us-east-1", label: "US East (N. Virginia)" },
	{ value: "us-east-2", label: "US East (Ohio)" },
	{ value: "us-west-1", label: "US West (N. California)" },
	{ value: "us-west-2", label: "US West (Oregon)" },
	{ value: "ca-central-1", label: "Canada (Central)" },
	{ value: "sa-east-1", label: "South America (São Paulo)" },
	{ value: "eu-west-1", label: "Europe (Ireland)" },
	{ value: "eu-west-2", label: "Europe (London)" },
	{ value: "eu-west-3", label: "Europe (Paris)" },
	{ value: "eu-central-1", label: "Europe (Frankfurt)" },
	{ value: "eu-central-2", label: "Europe (Zurich)" },
	{ value: "eu-north-1", label: "Europe (Stockholm)" },
	{ value: "eu-south-1", label: "Europe (Milan)" },
	{ value: "ap-south-1", label: "Asia Pacific (Mumbai)" },
	{ value: "ap-southeast-1", label: "Asia Pacific (Singapore)" },
	{ value: "ap-southeast-2", label: "Asia Pacific (Sydney)" },
	{ value: "ap-northeast-1", label: "Asia Pacific (Tokyo)" },
	{ value: "ap-northeast-2", label: "Asia Pacific (Seoul)" },
];

const codes = (...values: string[]): RegionOption[] => values.map((value) => ({ value, label: value }));

const B2_REGIONS = codes(
	"us-west-000",
	"us-west-001",
	"us-west-002",
	"us-west-004",
	"us-east-005",
	"eu-central-003",
	"ca-east-006",
);

const WASABI_REGIONS = codes(
	"us-east-1",
	"us-east-2",
	"us-central-1",
	"us-west-1",
	"us-west-2",
	"ca-central-1",
	"eu-central-1",
	"eu-central-2",
	"eu-west-1",
	"eu-west-2",
	"eu-south-1",
	"ap-northeast-1",
	"ap-northeast-2",
	"ap-southeast-1",
	"ap-southeast-2",
);

const HETZNER_REGIONS: readonly RegionOption[] = [
	{ value: "fsn1", label: "Falkenstein (fsn1)" },
	{ value: "nbg1", label: "Nuremberg (nbg1)" },
	{ value: "hel1", label: "Helsinki (hel1)" },
];

/** @public Exercised by the unit tests. */
export const R2_TOKEN_PAGE = "https://dash.cloudflare.com/?to=/:account/r2/api-tokens";

export const S3_PRESETS: readonly S3Preset[] = [
	{
		provider: "aws",
		label: "Amazon S3",
		addressing: "virtual",
		endpoint: ({ region }) => `s3.${region}.amazonaws.com`,
		applyCors: true,
		applyLifecycle: true,
		regions: AWS_REGIONS,
		tokenPage: { url: "https://console.aws.amazon.com/iam/home#/users", label: "IAM users" },
		credentialsHelp:
			"Create an access key for an IAM user whose policy allows the actions below on this bucket, and nothing else.",
	},
	{
		provider: "r2",
		label: "Cloudflare R2 (S3 API)",
		addressing: "path",
		endpoint: ({ accountId }) => `${accountId ?? ""}.r2.cloudflarestorage.com`,
		region: "auto",
		applyCors: true,
		applyLifecycle: false,
		tokenPage: { url: R2_TOKEN_PAGE, label: "R2 API tokens" },
		credentialsHelp:
			"Create an R2 API token with Object Read & Write, applied to this bucket only. Copy the Access Key ID and the Secret Access Key it shows once.",
	},
	{
		provider: "b2",
		label: "Backblaze B2",
		addressing: "virtual",
		endpoint: ({ region }) => `s3.${region}.backblazeb2.com`,
		applyCors: false,
		applyLifecycle: false,
		regions: B2_REGIONS,
		tokenPage: { url: "https://secure.backblaze.com/app_keys.htm", label: "Application keys" },
		credentialsHelp:
			"Create an application key with Read and Write access to this bucket. The keyID is the access key ID and the applicationKey is the secret.",
	},
	{
		provider: "wasabi",
		label: "Wasabi",
		addressing: "virtual",
		endpoint: ({ region }) => `s3.${region}.wasabisys.com`,
		applyCors: true,
		applyLifecycle: false,
		regions: WASABI_REGIONS,
		tokenPage: { url: "https://console.wasabisys.com/", label: "Wasabi console, Access Keys" },
		credentialsHelp: "Create an access key for a user whose policy allows reading and writing this bucket.",
	},
	{
		provider: "hetzner",
		label: "Hetzner Object Storage",
		addressing: "virtual",
		endpoint: ({ region }) => `${region}.your-objectstorage.com`,
		applyCors: false,
		applyLifecycle: false,
		regions: HETZNER_REGIONS,
		tokenPage: { url: "https://console.hetzner.cloud/", label: "Hetzner Console, Security, S3 credentials" },
		credentialsHelp: "Generate S3 credentials in the project that owns the bucket.",
	},
	{
		provider: "minio",
		label: "MinIO",
		addressing: "path",
		endpoint: null,
		applyCors: true,
		applyLifecycle: true,
		credentialsHelp: "Use an access key whose user has the readwrite policy, or a policy covering this bucket.",
	},
	{
		provider: "other",
		label: "Other S3-compatible",
		addressing: "path",
		endpoint: null,
		applyCors: false,
		applyLifecycle: false,
		credentialsHelp: "Use an access key that can read, write, list and delete objects in this bucket.",
	},
];

export function presetFor(provider: string): S3Preset | null {
	return S3_PRESETS.find((preset) => preset.provider === provider) ?? null;
}

export function isS3Provider(value: unknown): value is S3Provider {
	return typeof value === "string" && presetFor(value) !== null;
}

const B2_ENDPOINT = /^s3\.([a-z0-9-]+)\.backblazeb2\.com$/;

/**
 * `s3.us-west-004.backblazeb2.com` → `us-west-004`, as upstream's `b2RegionFromEndpoint`.
 * @public Exercised by the unit tests.
 */
export function b2RegionFromEndpoint(endpoint: string): string | null {
	return B2_ENDPOINT.exec(endpoint)?.[1] ?? null;
}

/** The region a preset's endpoint names, so an admin who pastes an endpoint need not type the region too. */
export function regionFromEndpoint(provider: S3Provider, endpoint: string): string | null {
	if (provider === "r2") return "auto";
	if (provider === "b2") return b2RegionFromEndpoint(endpoint);
	const patterns: Partial<Record<S3Provider, RegExp>> = {
		aws: /^s3[.-]([a-z0-9-]+)\.amazonaws\.com$/,
		wasabi: /^s3\.([a-z0-9-]+)\.wasabisys\.com$/,
		hetzner: /^([a-z0-9-]+)\.your-objectstorage\.com$/,
	};
	return patterns[provider]?.exec(endpoint)?.[1] ?? null;
}

export type ParsedEndpoint = { endpoint: string; scheme: "https" | "http" };

/**
 * Accepts `s3.example.com`, `https://s3.example.com/` or `http://localhost:9000` and returns the host (with
 * port) and scheme. A path, query, credentials or anything but http(s) is refused; whether `http` and private
 * hosts are allowed is the endpoint guard's decision, not this parser's.
 */
export function parseEndpoint(value: unknown): ParsedEndpoint | { error: string } {
	if (typeof value !== "string" || !value.trim()) return { error: "Enter the endpoint" };
	const raw = value.trim();
	const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
	let url: URL;
	try {
		url = new URL(withScheme);
	} catch {
		return { error: "Enter a valid endpoint host, for example s3.eu-central-1.amazonaws.com" };
	}
	if (url.protocol !== "https:" && url.protocol !== "http:") return { error: "The endpoint must use https" };
	if (url.username || url.password) return { error: "Do not put credentials in the endpoint" };
	if ((url.pathname && url.pathname !== "/") || url.search || url.hash)
		return { error: "The endpoint is a host only; put the bucket in its own field" };
	return { endpoint: url.host.toLowerCase(), scheme: url.protocol === "http:" ? "http" : "https" };
}

/** S3 bucket naming, loosened enough for providers that allow underscores or capitals in old buckets. */
export function isValidBucketName(value: unknown): value is string {
	return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{1,61}[A-Za-z0-9]$/.test(value);
}

/** `us-east-1`, `eu-central`, `fsn1`, `us-west-004`, `auto`. */
export function isValidStoreRegion(value: unknown): value is string {
	return typeof value === "string" && /^[a-z0-9][a-z0-9-]{0,40}$/.test(value);
}

/** Virtual-hosted addressing puts the bucket in a host name, which needs a DNS-safe bucket name. */
export function supportsVirtualAddressing(bucket: string): boolean {
	return /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket);
}

/** R2 jurisdictions with their own S3 endpoint; the default has none. */
export type R2Jurisdiction = "" | "eu" | "fedramp";

const R2_ENDPOINT = /^([0-9a-f]{32})(?:\.(eu|fedramp))?\.r2\.cloudflarestorage\.com$/i;

/**
 * The account id from what an admin pastes: the id itself, or the bucket's S3 endpoint as the R2 dashboard
 * shows it (with or without `https://` and the bucket path).
 */
export function normalizeR2AccountId(value: string): string {
	const raw = value.trim();
	const host = raw.replace(/^https?:\/\//i, "").split("/")[0] ?? "";
	return (R2_ENDPOINT.exec(host)?.[1] ?? raw).toLowerCase();
}

export function isValidR2AccountId(value: string): boolean {
	return /^[0-9a-f]{32}$/.test(value);
}

/** `<account>.r2.cloudflarestorage.com` (or `.eu.`) → the account id and jurisdiction; null for anything else. */
export function parseR2Endpoint(endpoint: string): { accountId: string; jurisdiction: R2Jurisdiction } | null {
	const match = R2_ENDPOINT.exec(endpoint);
	if (!match) return null;
	return { accountId: match[1].toLowerCase(), jurisdiction: (match[2]?.toLowerCase() ?? "") as R2Jurisdiction };
}

/**
 * The endpoint a preset builds from the region (and, for R2, the account id and jurisdiction), as an https URL;
 * null when the preset has no endpoint of its own or a part is missing.
 */
export function presetEndpoint(
	provider: S3Provider,
	input: { region: string; accountId?: string; jurisdiction?: R2Jurisdiction },
): string | null {
	if (provider === "r2") {
		const accountId = input.accountId ?? "";
		if (!isValidR2AccountId(accountId)) return null;
		return `https://${accountId}${input.jurisdiction ? `.${input.jurisdiction}` : ""}.r2.cloudflarestorage.com`;
	}
	const preset = presetFor(provider);
	if (!preset?.endpoint || !isValidStoreRegion(input.region)) return null;
	return `https://${preset.endpoint({ region: input.region })}`;
}

/** The R2 API tokens page, in the admin's own account once the id is known. */
export function r2TokenPage(accountId: string): string {
	return isValidR2AccountId(accountId) ? `https://dash.cloudflare.com/${accountId}/r2/api-tokens` : R2_TOKEN_PAGE;
}
