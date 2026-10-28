"use client";

import { Plus, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { List, ListRow } from "@/components/ui/list";
import type { AgentProviderConnection } from "@/lib/agent/provider-types";
import { agentProviderSummary } from "./utils";

type SavedProvidersProps = {
	providers: AgentProviderConnection[];
	/** The saved provider open in the editor, if any. */
	editingId: string | null;
	busy: boolean;
	onUse: (provider: AgentProviderConnection) => void;
	onEdit: (provider: AgentProviderConnection) => void;
	onDelete: (provider: AgentProviderConnection) => void;
	onAdd: () => void;
};

/** Every saved provider with one click to switch to it; the one in use cannot be deleted. */
export function SavedProviders({ providers, editingId, busy, onUse, onEdit, onDelete, onAdd }: SavedProvidersProps) {
	return (
		<section aria-labelledby="saved-providers-heading" className="space-y-3">
			<div className="flex items-center justify-between gap-3">
				<div>
					<h3 id="saved-providers-heading" className="text-sm font-medium text-neutral-900">
						Saved providers
					</h3>
					<p className="mt-0.5 text-xs text-neutral-500">
						Every AI feature uses the provider in use. Keys stay saved, so switching back needs no retyping.
					</p>
				</div>
				<Button type="button" variant="outline" size="sm" onClick={onAdd} disabled={busy}>
					<Plus className="h-3.5 w-3.5" />
					Add provider
				</Button>
			</div>
			{providers.length > 0 && (
				<List>
					{providers.map((provider) => (
						<ListRow
							key={provider.id}
							data-testid="saved-provider"
							data-provider-id={provider.id}
							aria-current={editingId === provider.id ? "true" : undefined}
							className={editingId === provider.id ? "bg-neutral-50" : undefined}
						>
							<div className="min-w-0 flex-1">
								<div className="flex items-center gap-2 text-sm font-medium text-neutral-900">
									<span className="truncate">{provider.name}</span>
									{provider.active && <Badge variant="success">In use</Badge>}
								</div>
								<p className="mt-0.5 truncate text-xs text-neutral-500">{agentProviderSummary(provider)}</p>
							</div>
							<div className="flex shrink-0 items-center gap-1">
								{!provider.active && (
									<Button
										type="button"
										size="sm"
										disabled={busy}
										onClick={() => onUse(provider)}
										aria-label={`Use ${provider.name}`}
									>
										Use this provider
									</Button>
								)}
								<Button
									type="button"
									variant="ghost"
									size="sm"
									disabled={busy}
									onClick={() => onEdit(provider)}
									aria-label={`Edit ${provider.name}`}
								>
									Edit
								</Button>
								<Button
									type="button"
									variant="ghost"
									size="icon"
									className="h-8 w-8 text-neutral-500 hover:text-red-700"
									disabled={busy || provider.active}
									title={provider.active ? "Switch to another provider before deleting this one" : undefined}
									onClick={() => onDelete(provider)}
									aria-label={`Delete ${provider.name}`}
								>
									<Trash2 className="h-4 w-4" />
								</Button>
							</div>
						</ListRow>
					))}
				</List>
			)}
		</section>
	);
}
