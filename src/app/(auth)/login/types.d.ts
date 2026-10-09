export type LoginResult = {
	userId?: string;
	redirect?: string;
	error?: string;
	/** Password accepted; a code from the authenticator is still needed. */
	mfaRequired?: boolean;
	challengeToken?: string;
};
