import type { ModuleAdminCapabilities } from "@/lib/modules/admin-types";

function Group({ title, items }: { title: string; items: { key: string; text: string; hint?: string }[] }) {
	if (!items.length) return null;
	return (
		<div>
			<h4 className="text-xs font-semibold uppercase tracking-wide text-neutral-500">{title}</h4>
			<ul className="mt-1.5 flex flex-wrap gap-1.5">
				{items.map((item) => (
					<li
						key={item.key}
						title={item.hint}
						className="rounded-md bg-neutral-100 px-2 py-0.5 font-mono text-xs text-neutral-700"
					>
						{item.text}
					</li>
				))}
			</ul>
		</div>
	);
}

/** What a module adds to the rest of Kite, as the manifest and its descriptors declare it. */
export function ModuleCapabilities({ capabilities }: { capabilities: ModuleAdminCapabilities }) {
	const { tools, scopes, webhookEvents, commands } = capabilities;
	if (!tools.length && !scopes.length && !webhookEvents.length && !commands.length) {
		return <p className="text-sm text-neutral-500">Adds no assistant tools, scopes, webhook events or commands.</p>;
	}
	return (
		<div className="space-y-3">
			<Group
				title="Assistant and MCP tools"
				items={tools.map((tool) => ({ key: tool.name, text: tool.name, hint: tool.description }))}
			/>
			<Group
				title="Scopes"
				items={scopes.map((scope) => ({ key: scope.scope, text: scope.scope, hint: scope.label }))}
			/>
			<Group
				title="Webhook events"
				items={webhookEvents.map((event) => ({ key: event.value, text: event.value, hint: event.label }))}
			/>
			<Group
				title="Commands"
				items={commands.map((command) => ({ key: command.id, text: command.id, hint: command.label }))}
			/>
		</div>
	);
}
