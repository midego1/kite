"use client";

import { useEffect, useState } from "react";
import { loadModuleClient } from "@/components/modules/client-registry";
import type { ModuleProposalCard } from "@/components/modules/client-registry-types";
import { useModules } from "@/components/modules/modules-context";
import { MODULE_IDS } from "@/lib/modules/client-data/module-ids";

/**
 * The module's own card body for a proposed tool call (`proposalCards` in its client chunk), loaded the first time
 * such a proposal shows; null while it loads, for a module that is off and for tools without one, which keep the
 * core card with the preview's lines.
 */
export function useModuleProposalCard(moduleId: string | undefined, action: string): ModuleProposalCard | null {
	const { isEnabled } = useModules();
	const known = MODULE_IDS.find((id) => id === moduleId);
	const on = !!known && isEnabled(known);
	const key = known && on ? `${known}:${action}` : null;
	const [loaded, setLoaded] = useState<{ key: string; card: ModuleProposalCard | null } | null>(null);
	useEffect(() => {
		if (!key || !known) return;
		const client = loadModuleClient(known);
		if (!client) return;
		let live = true;
		void client.then((chunk) => {
			if (live) setLoaded({ key, card: chunk.proposalCards?.[action] ?? null });
		});
		return () => {
			live = false;
		};
	}, [key, known, action]);
	return loaded && loaded.key === key ? loaded.card : null;
}
