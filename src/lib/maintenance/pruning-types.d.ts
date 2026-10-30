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
};

export type PruningResult = Record<string, number>;
