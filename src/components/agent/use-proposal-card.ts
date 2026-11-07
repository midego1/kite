"use client";

import { useEffect, useState } from "react";
import { hasModuleClient, loadModuleClient } from "@/components/modules/client-registry";
import type { ModuleProposalCard } from "@/components/modules/client-registry-types";
import { useModules } from "@/components/modules/modules-context";
import { MODULE_IDS } from "@/lib/modules/client-data/module-ids";
import { proposalCardStatus, type ProposalCardStatus } from "./proposal-card-utils";

/**
 * The module's own card body for a proposed tool call (`proposalCards` in its client chunk), loaded the first time
 * such a proposal shows, and where that load is (`proposalCardStatus`). A module that is off or has no client chunk
 * keeps the core card with the preview's lines at once; otherwise the card waits for the chunk.
 */
export function useModuleProposalCard(
	moduleId: string | undefined,
	action: string,
): { card: ModuleProposalCard | null; status: ProposalCardStatus } {
	const { isEnabled } = useModules();
	const known = MODULE_IDS.find((id) => id === moduleId);
	const key = known && isEnabled(known) && hasModuleClient(known) ? `${known}:${action}` : null;
	const [loaded, setLoaded] = useState<
		{ key: string; card: ModuleProposalCard | null } | { key: string; failed: true } | null
	>(null);
	useEffect(() => {
		if (!key || !known) return;
		const client = loadModuleClient(known);
		if (!client) return;
		let live = true;
		client.then(
			(chunk) => {
				if (live) setLoaded({ key, card: chunk.proposalCards?.[action] ?? null });
			},
			() => {
				if (live) setLoaded({ key, failed: true });
			},
		);
		return () => {
			live = false;
		};
	}, [key, known, action]);
	const current = loaded && loaded.key === key ? loaded : null;
	const card = current && "card" in current ? current.card : null;
	const status = proposalCardStatus(!!key, current ? ("failed" in current ? current : { card: !!card }) : null);
	return { card, status };
}
