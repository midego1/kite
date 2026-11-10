import type { SessionUser } from "@/lib/auth/types";

export type McpPrincipal = {
	keyId: string;
	user: SessionUser;
	scopes: string[];
	mailboxIds: string[];
	/** The key names mailboxes, whether or not any is still readable: an empty `mailboxIds` then means nothing. */
	mailboxLimited: boolean;
};
