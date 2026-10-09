export type SetupTokenInput = {
	configured: string | null | undefined;
	provided: string | null | undefined;
	production: boolean;
};

export type SetupTokenDecision =
	{ ok: true } | { ok: false; status: 401 | 503; setupTokenRequired: true; error: string };
