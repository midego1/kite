import type { AbuseChKeyStatus, KeyTestResults } from "@/lib/spam/providers/abuse-ch-types";

export interface GeneralSettings {
	outboundAttachmentMaxMb: number;
	/** Read-only; only GET reports it. One abuse.ch key turns on URLhaus and ThreatFox lookups together. */
	threatLookupsConfigured?: boolean;
	/** Read-only; only GET reports it. Where the abuse.ch key comes from, never the key. */
	threatLookupKey?: AbuseChKeyStatus;
}

export interface ThreatLookupKeySaved {
	status: AbuseChKeyStatus;
	results: KeyTestResults;
	/** Set when abuse.ch could not be reached and the key was saved unchecked. */
	warning?: string;
}
