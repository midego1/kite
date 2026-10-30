import {
	isValidBucketName,
	isValidR2AccountId,
	isValidStoreRegion,
	normalizeR2AccountId,
	parseEndpoint,
	parseR2Endpoint,
	presetEndpoint,
	presetFor,
	regionFromEndpoint,
	supportsVirtualAddressing,
} from "@/lib/storage/s3-presets-utils";
import { credentialProblem } from "@/lib/storage/credential-utils";
import type { S3Provider } from "@/lib/storage/types";
import type { ListStep, StoreForm, StoreFormErrors, StoreView } from "./types";

/** The bucket the default `BUCKET` binding uses in wrangler.jsonc. */
const DEFAULT_BINDING_BUCKET = "kite-raw";

export function emptyStoreForm(provider: S3Provider = "aws", sameAsBinding = false): StoreForm {
	return {
		name: sameAsBinding ? "Cloudflare R2 direct uploads" : "",
		provider,
		endpoint: "",
		customEndpoint: false,
		accountId: "",
		jurisdiction: "",
		region: presetFor(provider)?.region ?? "",
		bucket: sameAsBinding ? DEFAULT_BINDING_BUCKET : "",
		addressing: presetFor(provider)?.addressing ?? "path",
		accessKeyId: "",
		secretAccessKey: "",
		sameAsBinding,
	};
}

/** Whether the endpoint comes from the preset (region or account id) rather than a typed host. */
export function usesPresetEndpoint(form: Pick<StoreForm, "provider" | "customEndpoint">): boolean {
	return !!presetFor(form.provider)?.endpoint && !form.customEndpoint;
}

/** A saved store as the form; an endpoint the preset would not build keeps the custom endpoint field. */
export function storeFormOf(store: StoreView): StoreForm {
	const provider = store.provider as S3Provider;
	const form: StoreForm = {
		...emptyStoreForm(provider, store.sameAsBinding),
		name: store.name,
		endpoint: store.endpoint,
		region: store.region,
		bucket: store.bucket,
		addressing: store.addressing === "virtual" ? "virtual" : "path",
	};
	const r2 = provider === "r2" ? parseR2Endpoint(store.endpoint) : null;
	if (r2) return { ...form, ...r2 };
	const built = presetEndpoint(provider, { region: store.region });
	const preset = presetFor(provider);
	const matches = built === `https://${store.endpoint}` && store.addressing === preset?.addressing;
	return { ...form, customEndpoint: !!preset?.endpoint && !matches };
}

/** Picking a provider fills its addressing and fixed region; typed bucket, keys and name stay. */
export function withProvider(form: StoreForm, provider: S3Provider): StoreForm {
	const preset = presetFor(provider);
	// A typed region only carries over between providers that both take a free-form one (MinIO and Other).
	const freeForm = (entry: typeof preset) => !entry?.region && !entry?.regions;
	const keepRegion = freeForm(preset) && freeForm(presetFor(form.provider));
	return {
		...form,
		provider,
		customEndpoint: false,
		region: preset?.region ?? (keepRegion ? form.region : ""),
		addressing: preset?.addressing ?? form.addressing,
	};
}

/** The endpoint the form sends: built from the preset, or the typed one; "" while incomplete. */
export function formEndpoint(form: StoreForm): string {
	if (!usesPresetEndpoint(form)) return form.endpoint.trim();
	return (
		presetEndpoint(form.provider, {
			region: form.region,
			accountId: normalizeR2AccountId(form.accountId),
			jurisdiction: form.jurisdiction,
		}) ?? ""
	);
}

export function endpointPlaceholder(form: StoreForm): string {
	if (form.provider === "minio") return "http://minio.lan:9000";
	const preset = presetFor(form.provider);
	if (form.provider === "r2") return "https://<account id>.r2.cloudflarestorage.com";
	if (preset?.endpoint) return `https://${preset.endpoint({ region: form.region || "<region>" })}`;
	return "https://s3.example.com";
}

function nameError(name: string): string | undefined {
	if (!name) return "Enter a name";
	if (name.length > 80) return "Use at most 80 characters";
}

/** Account id or region for a preset endpoint; endpoint and region for a typed one. */
function locationErrors(form: StoreForm): StoreFormErrors {
	if (usesPresetEndpoint(form)) {
		if (form.provider !== "r2")
			return isValidStoreRegion(form.region.trim()) ? {} : { region: "Choose the bucket's region" };
		if (isValidR2AccountId(normalizeR2AccountId(form.accountId))) return {};
		return {
			accountId: form.accountId.trim()
				? "An account ID is 32 letters and digits (0-9, a-f)"
				: "Enter your Cloudflare account ID",
		};
	}
	const errors: StoreFormErrors = {};
	const endpoint = parseEndpoint(form.endpoint);
	if ("error" in endpoint) errors.endpoint = endpoint.error;
	const region = form.region.trim();
	const fromHost = "error" in endpoint ? null : regionFromEndpoint(form.provider, endpoint.endpoint);
	if (region && !isValidStoreRegion(region)) errors.region = "Use lowercase letters, digits and hyphens";
	else if (!region && !presetFor(form.provider)?.region && !fromHost)
		errors.region =
			form.provider === "minio"
				? "Enter the region (us-east-1 unless MinIO sets another)"
				: "Enter the bucket's region";
	return errors;
}

function bucketError(form: StoreForm): string | undefined {
	const bucket = form.bucket.trim();
	if (!bucket) return "Enter the bucket name";
	if (!isValidBucketName(bucket)) return "3 to 63 letters, digits, dots, hyphens or underscores";
	if (form.addressing === "virtual" && !supportsVirtualAddressing(bucket))
		return "This bucket name needs path-style addressing";
}

/** Where the form points: what the server compares before it lets a saved key pair sign anything. */
function locationOf(form: StoreForm) {
	const endpoint = parseEndpoint(formEndpoint(form));
	return [
		form.provider,
		"error" in endpoint ? formEndpoint(form) : `${endpoint.scheme}://${endpoint.endpoint}`,
		form.region.trim(),
		form.bucket.trim(),
		form.addressing,
	].join("|");
}

/**
 * Whether an edit points the store somewhere else, so the saved keys may not be used and must be typed again.
 * @public Exercised by the unit tests.
 */
export function locationMoved(form: StoreForm, saved: StoreForm | null): boolean {
	return !!saved && locationOf(form) !== locationOf(saved);
}

function keyErrors(form: StoreForm, editing: boolean, moved: boolean): StoreFormErrors {
	const key = form.accessKeyId.trim();
	const secret = form.secretAccessKey.trim();
	if (editing && !key && !secret) {
		if (!moved) return {};
		return {
			accessKeyId: "Enter the access key ID again",
			secretAccessKey: "Enter the secret again to use a different endpoint, bucket or region",
		};
	}
	return {
		accessKeyId: credentialProblem("accessKeyId", key, form.provider, { shape: true }) ?? undefined,
		secretAccessKey: credentialProblem("secretAccessKey", secret, form.provider, { shape: true }) ?? undefined,
	};
}

/** The messages shown under each field; a blank key pair is fine on an edit, which keeps the saved one. */
export function storeFormErrors(
	form: StoreForm,
	{ editing = false, saved = null }: { editing?: boolean; saved?: StoreForm | null } = {},
): StoreFormErrors {
	const errors: StoreFormErrors = {
		name: nameError(form.name.trim()),
		...locationErrors(form),
		bucket: bucketError(form),
		...keyErrors(form, editing, locationMoved(form, saved)),
	};
	return Object.fromEntries(Object.entries(errors).filter(([, message]) => message)) as StoreFormErrors;
}

/** The request body; on an edit, an empty key pair keeps the saved one, and `storeId` lets a test use it. */
export function storeFormBody(form: StoreForm, editing: boolean, storeId?: string | null): Record<string, unknown> {
	const body: Record<string, unknown> = {
		name: form.name.trim(),
		provider: form.provider,
		endpoint: formEndpoint(form),
		region: form.region.trim(),
		bucket: form.bucket.trim(),
		addressing: form.addressing,
	};
	if (storeId) body.storeId = storeId;
	if (!editing) body.sameAsBinding = form.sameAsBinding;
	if (!editing || form.accessKeyId || form.secretAccessKey) {
		body.accessKeyId = form.accessKeyId.trim();
		body.secretAccessKey = form.secretAccessKey.trim();
	}
	return body;
}

/** Whether a report's browser checks failed, so the dialog shows the CORS rule to copy. */
export function corsFailed(steps: ListStep[] | null): boolean {
	return !!steps?.some((step) => step.id.startsWith("cors_") && step.status === "failed");
}

/** One line above the step list: everything passed, only the browser checks failed, or a required one did. */
export function testSummary(steps: ListStep[]): { tone: "ok" | "warn" | "error"; text: string } {
	const failed = steps.filter((step) => step.status === "failed");
	if (!failed.length) return { tone: "ok", text: "Connection works. Every check passed." };
	if (failed.every((step) => step.id.startsWith("cors_")))
		return {
			tone: "warn",
			text: "Connection works, but browsers cannot upload directly yet. Add the CORS rule below.",
		};
	return {
		tone: "error",
		text: `${failed.length === 1 ? "One check" : `${failed.length} checks`} failed. See the fix under each.`,
	};
}
