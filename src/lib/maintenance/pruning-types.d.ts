export type PruningPolicy = {
	outboundJobsDays: number;
	webhookDeliveriesDays: number;
	autoReplyDeliveriesDays: number;
	expiredSessionsDays: number;
	expiredLoginChallengesDays: number;
	expiredPasswordResetTokensDays: number;
	agentActionsDays: number;
	staleSummariesDays: number;
	mcpToolCallAuditDays: number;
	unsubscribeAuditDays: number;
	/** Assistant by email request rows (docs/specs/assistant-by-email.md §12): 30 days, like a chat conversation. */
	assistantEmailRequestsDays: number;
	/** A `queued`/`running` request whose job never finished: its raw object is swept after this many days. */
	assistantEmailStaleRawDays: number;
};

export type PruningResult = Record<string, number>;
