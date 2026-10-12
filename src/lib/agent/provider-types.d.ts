export type AgentProviderKind = "cloudflare" | "compatible";
export type AgentProviderPreset = "openai" | "openrouter" | "groq" | "meta" | "custom";
export type AgentReasoningEffort = "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
/** USD per 1M tokens, plus the optional reasoning hint saved with the model. */
export type AgentModelRates = { input: number | null; output: number | null; reasoningEffort?: AgentReasoningEffort };

export type AgentProviderConfig = {
	provider: AgentProviderKind;
	preset: AgentProviderPreset;
	baseUrl: string;
	apiKey: string;
	model: string;
	models: string[];
	rates: Record<string, AgentModelRates>;
	source: "saved" | "environment" | "default";
};

export type AgentProviderPublicConfig = Omit<AgentProviderConfig, "apiKey"> & {
	hasApiKey: boolean;
	configured: boolean;
};

// rates are USD per 1M tokens, present only when the provider's own model catalog publishes pricing.
// trainsOnData marks a model whose prompts and completions the provider may use to train its models.
export type AgentModelOption = { id: string; name: string; rates?: AgentModelRates; trainsOnData?: boolean };
