import { META_AGENT_MODELS } from "./provider-constants";

/**
 * Model IDs known to let their provider use the prompts and completions sent to them for training. This is
 * the one place model IDs are matched; every guard reads this predicate or the `trainsOnData` flag instead.
 */
const TRAINING_MODEL_IDS = new Set(META_AGENT_MODELS.filter((model) => model.trainsOnData).map((model) => model.id));

/** True when the model ID names a catalog model whose provider may train on the prompts sent to it. */
export function modelTrainsOnData(modelId: string): boolean {
	return TRAINING_MODEL_IDS.has(modelId);
}
