"use client";

import { useRef } from "react";
import { CommandCenter } from "@/components/command-center/command-center";
import { useMigrationsCardSlot } from "@/components/use-migrations-notice";
import type { ReadingPaneEmptyStateProps } from "./reading-layout-types";

/**
 * The reading pane with nothing open: the command center (greeting, counts, accounts, what needs attention,
 * quick actions) with the database notice inside it, and the "Select a message to read" line at the bottom.
 */
export function ReadingPaneEmptyState({ config }: ReadingPaneEmptyStateProps) {
	const paneRef = useRef<HTMLDivElement>(null);
	// While this pane is on screen it carries the database notice, and the top banner steps aside.
	useMigrationsCardSlot(paneRef);

	return (
		<div ref={paneRef} className="h-full overflow-y-auto" data-testid="reading-pane-empty">
			<CommandCenter config={config} />
		</div>
	);
}
