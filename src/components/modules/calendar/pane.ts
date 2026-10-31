import type { ModulePaneClient } from "../client-registry-types";
import { TodayCard } from "./today-card";

/** The Calendar's reading pane chunk: only the Today card, so the empty pane loads nothing else of Calendar. */
export const readingPaneSlots: NonNullable<ModulePaneClient["readingPaneSlots"]> = {
	"calendar.today": { Card: TodayCard },
};
