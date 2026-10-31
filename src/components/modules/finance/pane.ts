import type { ModulePaneClient } from "../client-registry-types";
import { RenewalsCard } from "./renewals-card";

/** Money Watch's reading pane chunk: only the renewals card, so the empty pane loads none of its dialogs. */
export const readingPaneSlots: NonNullable<ModulePaneClient["readingPaneSlots"]> = {
	"finance.renewals": { Card: RenewalsCard },
};
