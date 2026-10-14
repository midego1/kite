import { z } from "zod";
import type { CapabilityDescriptor, JsonSchemaObject } from "./module-types";

export type CapabilitySchemas = { input: z.ZodType; output?: z.ZodType };
export type ModuleSchemas = Record<string, CapabilitySchemas>;
export type DescriptorMeta = Omit<CapabilityDescriptor, "name" | "inputSchema" | "outputSchema">;

/** Input schemas describe what a caller may send (defaults optional); output schemas what a handler returns. @public Test-only: used inside this file, exported for tests. */
export function toJsonSchema(schema: z.ZodType, io: "input" | "output"): JsonSchemaObject {
	return z.toJSONSchema(schema, { io }) as JsonSchemaObject;
}

/**
 * The JSON fragment of a triage model extension from a flat zod object: its properties as zod writes
 * them (a nullable field is an `anyOf` with `{ type: "null" }`), `additionalProperties: false` and no
 * `required`, so the model may leave out any field.
 */
export function toModelExtensionSchema(schema: z.ZodType): JsonSchemaObject {
	const json = toJsonSchema(schema, "input");
	return { type: "object", additionalProperties: false, properties: json.properties };
}

/** A descriptor whose JSON Schemas are generated from the module's zod schemas, so there is one source. */
export function describeCapability(schemas: ModuleSchemas, name: string, meta: DescriptorMeta): CapabilityDescriptor {
	const entry = schemas[name];
	if (!entry) throw new Error(`No schema for capability ${name}`);
	const descriptor: CapabilityDescriptor = { name, ...meta, inputSchema: toJsonSchema(entry.input, "input") };
	if (entry.output) descriptor.outputSchema = toJsonSchema(entry.output, "output");
	return descriptor;
}
