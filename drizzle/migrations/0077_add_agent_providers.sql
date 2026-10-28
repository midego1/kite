CREATE TABLE `agent_providers` (`id` text PRIMARY KEY NOT NULL, `name` text NOT NULL, `provider` text NOT NULL, `preset` text, `base_url` text, `api_key` text, `model` text NOT NULL, `model_rates` text, `active` integer DEFAULT 0 NOT NULL, `created_at` integer NOT NULL, `updated_at` integer NOT NULL);--> statement-breakpoint
CREATE UNIQUE INDEX `agent_providers_active_idx` ON `agent_providers` (`active`) WHERE "agent_providers"."active" = 1;--> statement-breakpoint
CREATE INDEX `agent_providers_created_idx` ON `agent_providers` (`created_at`);--> statement-breakpoint
INSERT INTO `agent_providers` (`id`, `name`, `provider`, `preset`, `base_url`, `api_key`, `model`, `model_rates`, `active`, `created_at`, `updated_at`)
SELECT 'aip_migrated',
	CASE WHEN `agent_provider` = 'cloudflare' THEN 'Cloudflare Workers AI'
		WHEN `agent_preset` = 'haimaker' THEN 'Haimaker.ai'
		WHEN `agent_preset` = 'anthropic' THEN 'Anthropic'
		WHEN `agent_preset` = 'openai' THEN 'OpenAI'
		WHEN `agent_preset` = 'openrouter' THEN 'OpenRouter'
		WHEN `agent_preset` = 'groq' THEN 'Groq'
		ELSE 'Custom endpoint' END,
	`agent_provider`,
	CASE WHEN `agent_provider` = 'compatible' THEN COALESCE(`agent_preset`, 'custom') ELSE NULL END,
	`agent_base_url`, `agent_api_key`, COALESCE(`agent_model`, ''), `agent_model_rates`, 1,
	CAST(strftime('%s', 'now') AS integer) * 1000, CAST(strftime('%s', 'now') AS integer) * 1000
FROM `app_settings` WHERE `id` = 'default' AND `agent_provider` IN ('cloudflare', 'compatible');
