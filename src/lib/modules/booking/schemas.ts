import { z } from "zod";
import type { ModuleSchemas } from "../schema-utils";
import { instantSchema, lifecycleSchemas, resolveRefsSchemas } from "../shared-schemas";

const workingHours = z
	.object({
		weekdays: z.array(z.number().int().min(0).max(6)),
		timeRanges: z.array(z.object({ startTime: z.string(), endTime: z.string() })),
		timeZone: z.string(),
	})
	.nullable();

const appointmentCreated = z.object({
	ref: z.object({ kind: z.literal("booking:appointment"), id: z.string() }),
	appointment: z.object({
		eventTypeId: z.string(),
		eventIds: z.array(z.string()),
		start: instantSchema,
		end: instantSchema,
		timeZone: z.string(),
		bookerName: z.string(),
		bookerEmail: z.string(),
	}),
});

export const bookingSchemas: ModuleSchemas = {
	workingHours: { input: z.object({ userId: z.string().min(1) }), output: workingHours },
	resolveRefs: resolveRefsSchemas(["booking:event_type", "booking:appointment"]),
	userCreated: lifecycleSchemas("user.created"),
	appointmentCreated: { input: appointmentCreated },
};
