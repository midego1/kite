export type AuthActivityAction =
	| "auth.login"
	| "auth.logout"
	| "auth.mfa_verified"
	| "auth.password_reset"
	| "auth.passkey_verified"
	| "auth.passkey_added"
	| "auth.passkey_removed"
	| "auth.mfa_reset";

export type AuthActivityMetadata = {
	ipAddress: string;
	city: string | null;
	country: string | null;
	device: string;
	platform: string;
	userAgent: string;
};
