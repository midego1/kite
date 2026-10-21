import type { S3Addressing, S3Provider } from "./types";

export type S3Preset = {
	provider: S3Provider;
	label: string;
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

export const S3_PRESETS: readonly S3Preset[] = [
	{
		provider: "aws",
		label: "Amazon S3",
		addressing: "virtual",
		endpoint: ({ region }) => `s3.${region}.amazonaws.com`,
		applyCors: true,
		applyLifecycle: true,
	},
	{
		provider: "r2",
		label: "Cloudflare R2 (S3 API)",
		addressing: "path",
		endpoint: ({ accountId }) => `${accountId ?? ""}.r2.cloudflarestorage.com`,
		region: "auto",
		applyCors: true,
		applyLifecycle: false,
	},
	{
		provider: "b2",
		label: "Backblaze B2",
		addressing: "virtual",
		endpoint: ({ region }) => `s3.${region}.backblazeb2.com`,
		applyCors: false,
		applyLifecycle: false,
	},
	{
		provider: "wasabi",
		label: "Wasabi",
		addressing: "virtual",
		endpoint: ({ region }) => `s3.${region}.wasabisys.com`,
		applyCors: true,
		applyLifecycle: false,
	},
	{
		provider: "hetzner",
		label: "Hetzner Object Storage",
		addressing: "virtual",
		endpoint: ({ region }) => `${region}.your-objectstorage.com`,
		applyCors: false,
		applyLifecycle: false,
	},
	{
		provider: "minio",
		label: "MinIO",
		addressing: "path",
		endpoint: null,
		applyCors: true,
		applyLifecycle: true,
	},
	{
		provider: "other",
		label: "Other S3-compatible",
		addressing: "path",
		endpoint: null,
		applyCors: false,
		applyLifecycle: false,
	},
];

export function presetFor(provider: string): S3Preset | null {
	return S3_PRESETS.find((preset) => preset.provider === provider) ?? null;
}

export function isS3Provider(value: unknown): value is S3Provider {
	return typeof value === "string" && presetFor(value) !== null;
}

const B2_ENDPOINT = /^s3\.([a-z0-9-]+)\.backblazeb2\.com$/;

/** `s3.us-west-004.backblazeb2.com` → `us-west-004`, as upstream's `b2RegionFromEndpoint`. */
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
