import { updateSendingSettingsSchema } from "@/lib/validators";
import type { UpdateSendingSettingsInput } from "./types";

export async function parseUpdateSendingSettingsRequest(request: Request): Promise<UpdateSendingSettingsInput> {
	return updateSendingSettingsSchema.parse(await request.json());
}
