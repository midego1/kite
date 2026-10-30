/**
 * The counts behind the admin overview (`GET /api/admin/overview`). A part is `null` when the viewer may not read
 * it: domains need the domain grant, the rest of the install-level parts the primary admin.
 */
export type AdminOverviewCounts = {
	accounts: { total: number; admins: number; disabled: number };
	mailboxes: { total: number; shared: number };
	domains: { total: number; active: number; inactive: number } | null;
	/** Enabled webhooks with a failed or exhausted delivery attempted in the last day, and how many such deliveries. */
	webhooks: { failingHooks: number; recentFailures: number } | null;
	/** Failed AI requests in the last day; `capped` when the kept list may hold more than were counted. */
	aiErrors: { recent: number; capped: boolean } | null;
};
