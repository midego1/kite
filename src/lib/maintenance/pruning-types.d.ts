export type PruningPolicy = {
	outboundJobsDays: number;
	webhookDeliveriesDays: number;
	autoReplyDeliveriesDays: number;
	expiredSessionsDays: number;
	expiredLoginChallengesDays: number;
	expiredPasswordResetTokensDays: number;
};

export type PruningResult = Record<string, number>;
