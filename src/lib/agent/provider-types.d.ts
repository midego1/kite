export type AgentProviderKind = "cloudflare" | "compatible";
export type AgentProviderPreset = "haimaker" | "anthropic" | "openai" | "openrouter" | "groq" | "custom";
export type AgentReasoningEffort = "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
/** Higher USD per 1M token rates for a request whose prompt is over `aboveInputTokens`. */
export type AgentLongContextRates = { aboveInputTokens: number; input: number; output: number };
/**
 * USD per 1M tokens, plus the optional reasoning hint saved with the model. `longContext` comes only from Kite's
 * price list; rates an admin enters are flat.
 */
export type AgentModelRates = {
	input: number | null;
	output: number | null;
	reasoningEffort?: AgentReasoningEffort;
	longContext?: AgentLongContextRates;
};

/** A model's rates from Kite's built-in price list, with where and when they were read. */
export type BuiltinModelPrice = {
	/** The price list entry that matched, which differs from the configured id for an alias or a dated id. */
	id: string;
	input: number;
	output: number;
	longContext?: AgentLongContextRates;
	source: string;
	asOf: string;
};

export type AgentProviderConfig = {
	provider: AgentProviderKind;
	preset: AgentProviderPreset;
	baseUrl: string;
	apiKey: string;
	model: string;
	models: string[];
	/** The rates saved in Admin → Agent: typed by the admin or published by the provider's catalog. */
	rates: Record<string, AgentModelRates>;
	/** What spend counts with for each configured model: the saved rates, else Kite's price list. */
	effectiveRates: Record<string, AgentModelRates>;
	source: "saved" | "environment" | "default";
	/** The saved key could not be opened (sealed under another APP_ENCRYPTION_KEY); requests fail until it is entered again. */
	keyUnreadable?: boolean;
};

export type AgentProviderPublicConfig = Omit<AgentProviderConfig, "apiKey" | "effectiveRates"> & {
	hasApiKey: boolean;
	configured: boolean;
};

// rates are USD per 1M tokens, present only when the provider's own model catalog publishes pricing.
export type AgentModelOption = { id: string; name: string; rates?: AgentModelRates };

/** A saved provider as the admin page lists it: never the key, only whether one is stored. */
export type AgentProviderConnection = Omit<AgentProviderPublicConfig, "source" | "configured"> & {
	id: string;
	name: string;
	active: boolean;
};
