import type { ModuleClient } from "../client-registry-types";
import { SaveAttachmentDialog } from "./save-attachment-dialog";

export const attachmentSlots: NonNullable<ModuleClient["attachmentSlots"]> = {
	"drive.save-attachment": { Overlay: SaveAttachmentDialog },
};
