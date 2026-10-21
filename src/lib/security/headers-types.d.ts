export type ContentSecurityPolicyOptions = {
	nonce?: string;
	dev?: boolean;
	/** Exact origins of object stores browsers upload to directly (presigned URLs); never wildcards. */
	connectSources?: readonly string[];
};
