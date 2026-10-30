/**
 * Whose domains a user sees: an account that only manages its own mailboxes works on the domains of the admin who
 * created it; everyone else on their own. `/api/domains`, `/api/v1/domains` and the admin overview share this rule.
 */
export function domainOwnerId(user: {
	id: string;
	canManageMailboxes: boolean;
	createdByUserId: string | null;
}): string {
	return user.canManageMailboxes && user.createdByUserId ? user.createdByUserId : user.id;
}
