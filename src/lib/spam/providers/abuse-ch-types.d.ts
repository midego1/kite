import type { AttachmentContent } from "@/lib/email/attachment-types";

export type AbuseChService = "urlhaus" | "threatfox";
/** What a lookup asks about: a link (URL or host) or an attachment hash. */
export type LookupKind = "link" | "payload";
/** A refused key is told apart from other failures so it can be logged; both count as not listed. */
export type LookupOutcome = "listed" | "not_listed" | "key_rejected" | "failed";

export type LookupRequest = {
	service: AbuseChService;
	kind: LookupKind;
	/** Original URLs or attachment hashes covered by this lookup; never persisted or logged. */
	inputs: readonly string[];
	url: string;
	contentType: string;
	body: string;
	listed: (answer: unknown) => boolean;
};

export type LookupResult = Pick<LookupRequest, "service" | "kind" | "inputs"> & { outcome: LookupOutcome };

export type ThreatLookupPlan = { urls: string[]; payloads: AttachmentContent[] };

export type KeyTestResult = "works" | "rejected" | "unreachable";
export type KeyTestResults = Record<AbuseChService, KeyTestResult>;

/** Where the key lookups use comes from: a deployment secret, or the owner's entry in Admin → General. */
export type AbuseChKeySource = "secret" | "settings";
export type AbuseChSecretName = "URLHAUS_AUTH_KEY" | "ABUSE_CH_AUTH_KEY";
export type ResolvedAbuseChKey = { key: string; source: AbuseChKeySource };
/** A key either list refuses is not saved; when abuse.ch cannot be reached it is saved unchecked. */
export type KeySaveDecision = "verified" | "unverified" | "rejected";

/** What the owner may see about the key; never the key itself. */
export type AbuseChKeyStatus = {
	/** The key lookups use, or null when there is none (an unreadable saved key counts as none). */
	source: AbuseChKeySource | null;
	/** The secret holding the key when `source` is "secret". */
	secretName: AbuseChSecretName | null;
	/** A saved key exists but cannot be decrypted; APP_ENCRYPTION_KEY is missing or changed. */
	unreadable: boolean;
	/** The migration adding the saved key has not been applied, so no key can be saved yet. */
	updatePending: boolean;
	/** The self-hosted server, where the secret is an environment variable. */
	nodeRuntime: boolean;
};
