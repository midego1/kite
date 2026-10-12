import type { AgentModelOption, AgentProviderPreset } from "./provider-types";

export const AGENT_SETTINGS_ID = "default";
export const DEFAULT_CLOUDFLARE_MODEL = "@cf/moonshotai/kimi-k2.5";
export const PROVIDER_BASE_URLS: Record<Exclude<AgentProviderPreset, "custom">, string> = {
	openai: "https://api.openai.com/v1",
	openrouter: "https://openrouter.ai/api/v1",
	groq: "https://api.groq.com/openai/v1",
	meta: "https://api.meta.ai/v1",
};

/** Meta's Muse Spark 1.3 models, shown for the `meta` preset even before an API key is entered. */
export const META_AGENT_MODELS: AgentModelOption[] = [
	{ id: "muse-spark-1.3", name: "Muse Spark 1.3", rates: { input: 1.25, output: 4.25 } },
	{
		id: "muse-spark-1.3-contributor",
		name: "Muse Spark 1.3 (contributor)",
		rates: { input: 0.1, output: 0.2 },
		trainsOnData: true,
	},
];

/** Shown wherever a model that lets its provider train on the prompts sent to it can be picked or typed. */
export const TRAINING_MODEL_WARNING =
	"Meta may use your prompts and replies, including email content, to train its models.";
