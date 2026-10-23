export interface GeneralSettings {
	outboundAttachmentMaxMb: number;
	/** Read-only; only GET reports it. One abuse.ch key turns on URLhaus and ThreatFox lookups together. */
	threatLookupsConfigured?: boolean;
}
