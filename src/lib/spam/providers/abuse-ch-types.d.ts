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
