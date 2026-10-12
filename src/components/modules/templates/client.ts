import type { ModuleClient } from "../client-registry-types";
import { NewTemplateDialog } from "./new-template-dialog";
import { TemplateMenu } from "./template-menu";

export const composerSlots: NonNullable<ModuleClient["composerSlots"]> = {
	"templates.send-menu": { MenuItem: TemplateMenu, Overlay: NewTemplateDialog },
};
