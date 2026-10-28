"use client";

import { useEffect, useState } from "react";
import { mergePublishedAgentRates } from "@/lib/agent/model-rates-utils";
import type { AgentAdminForm, AgentModelLoadState, AgentProviderEditTarget } from "./types";
import { agentModelInputError, loadAgentModels } from "./utils";

/**
 * The model catalog for the form's provider settings, loaded again (after a short pause while typing) whenever
 * they change. Rates a catalog publishes are merged into the form.
 */
export function useAgentModels(
	form: AgentAdminForm,
	target: AgentProviderEditTarget,
	canUseSavedKey: boolean,
	setForm: (update: (current: AgentAdminForm) => AgentAdminForm) => void,
) {
	const [modelLoad, setModelLoad] = useState<AgentModelLoadState | null>(null);
	const modelInputError = agentModelInputError(form, canUseSavedKey);
	// Model results belong to the provider settings they were loaded for; any change hides them.
	const modelsKey = JSON.stringify([form.provider, form.preset, form.baseUrl, form.apiKey, canUseSavedKey]);
	const current = modelLoad?.key === modelsKey ? modelLoad : null;
	useEffect(() => {
		if (modelInputError) return;
		const controller = new AbortController();
		const timer = window.setTimeout(
			() => {
				setModelLoad({ key: modelsKey, loading: true, models: [], source: null, error: null });
				void loadAgentModels(form, target, controller.signal)
					.then((data) => {
						setModelLoad({ key: modelsKey, loading: false, models: data.models, source: data.source, error: null });
						const published = Object.fromEntries(
							data.models.flatMap((item) => (item.rates ? [[item.id, item.rates]] : [])),
						);
						if (Object.keys(published).length)
							setForm((value) => ({ ...value, rates: mergePublishedAgentRates(value.rates, published) }));
					})
					.catch((error) => {
						if (!controller.signal.aborted)
							setModelLoad({
								key: modelsKey,
								loading: false,
								models: [],
								source: null,
								error: error instanceof Error ? error.message : "Could not load models",
							});
					});
			},
			form.provider === "cloudflare" ? 0 : 500,
		);
		return () => {
			window.clearTimeout(timer);
			controller.abort();
		};
		// The request sends the whole form, but only provider settings decide which models exist.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [modelsKey, modelInputError]);
	return {
		models: current?.models ?? [],
		modelSource: current?.source ?? null,
		modelsLoading: current?.loading ?? false,
		modelError: modelInputError ?? current?.error ?? null,
	};
}
