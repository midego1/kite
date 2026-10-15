import type { JsonSchemaObject, ModuleCapabilities, ModuleId } from "@/lib/modules/module-types";

/** The most extra output tokens all active extensions together may add to a triage request.
 * @public Exercised by the bundled unit tests.
 */
export const MODULE_EXTENSION_MAX_OUTPUT_TOKENS = 200;
/** A module's answer under `modules.<id>` is dropped when its JSON is longer than this. */
const MODULE_EXTENSION_MAX_JSON_CHARS = 2_048;

/** One triage step's model extension, with the module that declared it. */
export type ActiveModelExtension = {
	moduleId: ModuleId;
	/** The step capability that declared it. */
	capability: string;
	jsonSchema: JsonSchemaObject;
	instructions: string;
	maxOutputTokens: number;
	/** The module's `service` capability that says whether the model is worth asking, if any. */
	wantsModel: string | null;
	/** The step's key in `capabilities.modules`, or null when it has no switch of its own. */
	switchKey: string | null;
};

/** Every declared extension of every module's `triage_step` descriptors, whether or not the module is on. */
export function declaredModelExtensions(all: readonly ModuleCapabilities[]): ActiveModelExtension[] {
	return all.flatMap((entry) =>
		entry.descriptors.flatMap((descriptor) => {
			const model = descriptor.surfaces.includes("triage_step") ? descriptor.triage?.model : undefined;
			if (!model) return [];
			return [
				{
					moduleId: entry.moduleId,
					capability: descriptor.name,
					jsonSchema: model.jsonSchema,
					instructions: model.instructions,
					maxOutputTokens: model.maxOutputTokens,
					wantsModel: model.wantsModel ?? null,
					switchKey: descriptor.triage?.capability ?? null,
				},
			];
		}),
	);
}

/** The extra output tokens the extensions may use: their sum, capped at 200 in total. */
export function extensionOutputTokens(extensions: readonly Pick<ActiveModelExtension, "maxOutputTokens">[]): number {
	const sum = extensions.reduce((total, extension) => total + Math.max(0, extension.maxOutputTokens), 0);
	return Math.min(MODULE_EXTENSION_MAX_OUTPUT_TOKENS, sum);
}

/**
 * The provider schema for one request: the core schema unchanged without extensions, else with an
 * optional `modules` object holding each extension's schema under its module id. `modules` is never required.
 */
export function extendTriageJsonSchema(
	base: JsonSchemaObject,
	extensions: readonly Pick<ActiveModelExtension, "moduleId" | "jsonSchema">[],
): JsonSchemaObject {
	if (extensions.length === 0) return base;
	const properties = (base.properties ?? {}) as JsonSchemaObject;
	const modules: JsonSchemaObject = {};
	for (const extension of extensions) modules[extension.moduleId] = extension.jsonSchema;
	return {
		...base,
		properties: { ...properties, modules: { type: "object", additionalProperties: false, properties: modules } },
	};
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function jsonLength(value: unknown): number {
	try {
		return JSON.stringify(value)?.length ?? 0;
	} catch {
		return Infinity;
	}
}

/**
 * What the model answered under `modules`, kept leniently: only the active modules' keys, each at most
 * 2 KB of JSON. Anything else, including a `modules` value that is not an object, is dropped and never
 * makes the answer invalid. Undefined when nothing is left.
 */
export function keepActiveModules(
	raw: unknown,
	activeModuleIds: readonly string[],
): Record<string, unknown> | undefined {
	if (!isPlainObject(raw) || activeModuleIds.length === 0) return undefined;
	const kept: Record<string, unknown> = {};
	for (const id of activeModuleIds) {
		if (!Object.hasOwn(raw, id)) continue;
		const value = raw[id];
		if (value === undefined || jsonLength(value) > MODULE_EXTENSION_MAX_JSON_CHARS) continue;
		kept[id] = value;
	}
	return Object.keys(kept).length > 0 ? kept : undefined;
}

/** The model answer one step receives: the core fields and only its own module's key under `modules`. */
export function modelForStep(model: unknown, moduleId: string): unknown {
	if (!isPlainObject(model)) return model ?? null;
	const { modules, ...core } = model;
	if (!isPlainObject(modules) || !Object.hasOwn(modules, moduleId)) return core;
	return { ...core, modules: { [moduleId]: modules[moduleId] } };
}

/** A hint counts only when it answered exactly `{ wantsModel: true }`; an error, a timeout or anything else is false. */
export function hintSaysYes(result: unknown): boolean {
	if (!isPlainObject(result) || result.ok !== true || !isPlainObject(result.output)) return false;
	return result.output.wantsModel === true;
}
