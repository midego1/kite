import type { updateSendingSettingsSchema } from "@/lib/validators";
import type { z } from "zod";

export type UpdateSendingSettingsInput = z.infer<typeof updateSendingSettingsSchema>;

export type SendingSettingsResponse = {
	previewEnabled: boolean;
	undoSeconds: number;
};
