export type AuthMeUser = {
	id: string;
	email: string;
	name: string;
	timeZone: string | null;
	resetEmail: string | null;
	forwardingEmail: string | null;
	canForwardEmail: boolean;
	role: "admin" | "user";
	isPrimaryAdmin: boolean;
	canManageMailboxes: boolean;
	canManageDomains: boolean;
	canManageUsers: boolean;
	keyboardShortcutsEnabled: boolean;
	spamProtectionEnabled: boolean;
	showFullRecipientAddresses: boolean;
	hasAvatar: boolean;
	mfaEnabled: boolean;
};

/** `GET /api/auth/me`, the one session lookup every client consumer shares. */
export type AuthMeResponse = {
	user: AuthMeUser;
	runtime: "node" | "cloudflare";
	managesDns: boolean;
	hasMailboxes: boolean;
	isSetup: boolean;
};
