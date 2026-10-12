export type ActivityMetadata = {
	ipAddress?: string;
	city?: string | null;
	country?: string | null;
	device?: string;
	platform?: string;
	userAgent?: string;
	/** Module changes: the module, whether it is on or allowed, and the user a per-user change names. */
	moduleId?: string;
	allowed?: boolean;
	ref?: { kind: string; id: string };
};

export type ActivityLog = {
	id: string;
	action: "auth.login" | "auth.logout" | string;
	metadata: string | null;
	createdAt: string;
	actorEmail: string | null;
	targetEmail?: string | null;
};
