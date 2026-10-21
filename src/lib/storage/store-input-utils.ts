import type { StoreRecord } from "./config-utils";
import {
	isS3Provider,
	isValidBucketName,
	isValidStoreRegion,
	parseEndpoint,
	presetFor,
	regionFromEndpoint,
	supportsVirtualAddressing,
} from "./s3-presets-utils";
import type { S3Addressing, S3Credentials, S3Location, S3Provider } from "./types";

export type StoreInput = {
	name: string;
	provider: S3Provider;
	location: S3Location;
	/** Absent on an update that keeps the saved key pair. */
	credentials: S3Credentials | null;
	sameAsBinding: boolean;
};

export type StoreInputResult = { ok: true; value: StoreInput } | { ok: false; error: string };

const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");

function parseCredentialsInput(
	body: Record<string, unknown>,
	existing: StoreRecord | null,
): S3Credentials | null | { error: string } {
	const accessKeyId = text(body.accessKeyId);
	const secretAccessKey = text(body.secretAccessKey);
	if (!accessKeyId && !secretAccessKey && existing) return null;
	if (!accessKeyId || !secretAccessKey) return { error: "Enter the access key ID and the secret" };
	if (accessKeyId.length > 256 || secretAccessKey.length > 256 || /\s/.test(accessKeyId + secretAccessKey))
		return { error: "That does not look like an access key pair" };
	return { accessKeyId, secretAccessKey };
}

/** The typed region, else the preset's fixed one, else the one in the endpoint host. */
function regionOf(typed: string, provider: S3Provider, endpoint: string): string {
	return typed || presetFor(provider)?.region || regionFromEndpoint(provider, endpoint) || "";
}

type Fields = { pick(field: string, fallback: string): string; body: Record<string, unknown> };

function parseLocation(
	{ pick, body }: Fields,
	provider: S3Provider,
	existing: StoreRecord | null,
): S3Location | { error: string } {
	const saved = existing?.location;
	const endpoint = parseEndpoint(
		body.endpoint === undefined && saved ? `${saved.scheme}://${saved.endpoint}` : body.endpoint,
	);
	if ("error" in endpoint) return endpoint;
	const bucket = pick("bucket", saved?.bucket ?? "");
	if (!isValidBucketName(bucket)) return { error: "Enter a valid bucket name" };
	const region = regionOf(pick("region", saved?.region ?? ""), provider, endpoint.endpoint);
	if (!isValidStoreRegion(region)) return { error: "Enter the bucket's region" };
	const addressing = pick("addressing", saved?.addressing ?? presetFor(provider)?.addressing ?? "path");
	if (addressing !== "virtual" && addressing !== "path") return { error: "Addressing is virtual or path" };
	if (addressing === "virtual" && !supportsVirtualAddressing(bucket))
		return { error: "This bucket name needs path-style addressing" };
	return { ...endpoint, region, bucket, addressing: addressing satisfies S3Addressing };
}

/**
 * Reads the Add or Edit store form. On an edit, omitted fields keep the saved values and an empty key pair keeps
 * the saved credentials; any change still goes through the full validation before it is saved.
 */
export function parseStoreInput(raw: unknown, existing: StoreRecord | null = null): StoreInputResult {
	if (!raw || typeof raw !== "object") return { ok: false, error: "Send the store settings as JSON" };
	const body = raw as Record<string, unknown>;
	const pick = (field: string, fallback: string) => (body[field] === undefined ? fallback : text(body[field]));
	const name = pick("name", existing?.name ?? "");
	if (!name || name.length > 80) return { ok: false, error: "Enter a name of up to 80 characters" };
	const provider = pick("provider", existing?.provider ?? "");
	if (!isS3Provider(provider)) return { ok: false, error: "Choose a provider" };
	const location = parseLocation({ pick, body }, provider, existing);
	if ("error" in location) return { ok: false, error: location.error };
	const sameAsBinding = body.sameAsBinding === undefined ? !!existing?.sameAsBinding : body.sameAsBinding === true;
	if (sameAsBinding && provider !== "r2")
		return { ok: false, error: "Direct uploads for the default store need R2 S3 API keys" };
	const credentials = parseCredentialsInput(body, existing);
	if (credentials && "error" in credentials) return { ok: false, error: credentials.error };
	return { ok: true, value: { name, provider, location, credentials, sameAsBinding } };
}

/** Whether an edit changes anything the validation proves, so it must run again before saving. */
export function needsRevalidation(existing: StoreRecord, input: StoreInput): boolean {
	const a = existing.location;
	const b = input.location;
	return (
		!!input.credentials ||
		a.endpoint !== b.endpoint ||
		a.scheme !== b.scheme ||
		a.region !== b.region ||
		a.bucket !== b.bucket ||
		a.addressing !== b.addressing ||
		existing.provider !== input.provider
	);
}

/** The origins a CORS rule allows: the browser's own origin and APP_URL's, without duplicates. */
export function corsOrigins(...origins: (string | null | undefined)[]): string[] {
	const result = new Set<string>();
	for (const origin of origins) {
		if (!origin) continue;
		try {
			const url = new URL(origin);
			if (url.protocol === "https:" || url.protocol === "http:") result.add(url.origin);
		} catch {
			// Not an origin; skipped.
		}
	}
	return [...result];
}
