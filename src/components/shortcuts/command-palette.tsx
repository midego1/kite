"use client";

import React, { useMemo, useState } from "react";
import { CornerDownLeft } from "lucide-react";
import toast from "react-hot-toast";
import {
	Command,
	CommandDialog,
	CommandGroup,
	CommandInput,
	CommandItem as CommandRow,
	CommandList,
	CommandShortcut,
} from "@/components/ui/command";
import type { CommandItem } from "./types";
import { CommandParamForm } from "./command-palette-params";
import { filterCommands, groupCommandsByCategory } from "./command-palette-utils";

interface CommandPaletteProps {
	isOpen: boolean;
	onClose: () => void;
	commands: CommandItem[];
}

function PaletteCommand({ item, onSelect }: { item: CommandItem; onSelect: () => void }) {
	const Icon = item.icon;
	return (
		<CommandRow value={item.id} onSelect={onSelect}>
			<span className="flex min-w-0 items-center gap-3">
				{Icon && (
					<Icon className="h-4 w-4 shrink-0 text-neutral-500 group-data-[selected=true]/command-item:text-white" />
				)}
				<span className="truncate">
					<span className="text-sm font-medium">{item.title}</span>
					{item.subtitle && (
						<span className="ml-2 truncate text-xs text-neutral-500 group-data-[selected=true]/command-item:text-white">
							{item.subtitle}
						</span>
					)}
				</span>
			</span>
			{item.shortcut && <CommandShortcut>{item.shortcut}</CommandShortcut>}
		</CommandRow>
	);
}

/**
 * Cmd+K: every command core and the enabled modules offer, filtered as you type (cmdk handles the arrow
 * keys and the active option). A command with parameters asks for them before it runs.
 */
function CommandPaletteDialog({ onClose, commands }: { onClose: () => void; commands: CommandItem[] }) {
	const [query, setQuery] = useState("");
	const [pending, setPending] = useState<CommandItem | null>(null);
	const [values, setValues] = useState<Record<string, string>>({});
	const [paramError, setParamError] = useState<string | null>(null);
	const filtered = useMemo(() => filterCommands(commands, query), [commands, query]);
	const grouped = useMemo(() => groupCommandsByCategory(filtered), [filtered]);

	const select = (item: CommandItem) => {
		if (item.params?.length) {
			setPending(item);
			setValues({});
			setParamError(null);
			return;
		}
		const result = item.perform();
		onClose();
		void Promise.resolve(result).then((message) => {
			if (typeof message === "string") toast.error(message);
		});
	};

	const submitParams = async () => {
		if (!pending) return;
		const entered = Object.fromEntries(Object.entries(values).filter(([, value]) => value.trim() !== ""));
		const message = await pending.perform(entered);
		if (typeof message === "string") setParamError(message);
		else onClose();
	};

	return (
		<CommandDialog
			title="Command palette"
			open
			onOpenChange={(open) => {
				if (!open) onClose();
			}}
			onEscapeKeyDown={(event) => {
				// Escape leaves the parameter form for the list before it closes the palette.
				if (!pending) return;
				event.preventDefault();
				setPending(null);
			}}
		>
			<Command
				label="Search commands"
				shouldFilter={false}
				loop
				onKeyDown={(event) => {
					if (!pending || event.key !== "Enter") return;
					event.preventDefault();
					void submitParams();
				}}
			>
				<CommandInput
					value={query}
					onValueChange={setQuery}
					disabled={pending !== null}
					placeholder="Type a command or search actions..."
				>
					<kbd className="rounded-md border border-neutral-200 bg-neutral-100 px-2 py-0.5 text-xs font-semibold text-neutral-500 shadow-2xs">
						ESC
					</kbd>
				</CommandInput>
				{pending ? (
					<CommandParamForm
						item={pending}
						values={values}
						error={paramError}
						onChange={(name, value) => setValues((previous) => ({ ...previous, [name]: value }))}
					/>
				) : (
					<CommandList label="Commands">
						{filtered.length === 0 ? (
							<div role="status" className="p-8 text-center text-sm text-neutral-500">
								No matching commands found for &ldquo;{query}&rdquo;
							</div>
						) : (
							Object.entries(grouped).map(([category, items]) => (
								<CommandGroup key={category} heading={category}>
									{items.map((item) => (
										<PaletteCommand key={item.id} item={item} onSelect={() => select(item)} />
									))}
								</CommandGroup>
							))
						)}
					</CommandList>
				)}
				<div className="flex items-center justify-between border-t border-neutral-100 bg-neutral-50 px-4 py-2.5 text-xs text-neutral-500">
					<div className="flex items-center gap-3">
						<span>
							<kbd className="mr-1 rounded bg-neutral-200 px-1.5 py-0.5 text-[10px]">↑↓</kbd>
							to navigate
						</span>
						<span className="flex items-center">
							<CornerDownLeft className="mr-1 inline h-3 w-3" />
							to select
						</span>
					</div>
					<span className="text-[11px]">Kite Actions</span>
				</div>
			</Command>
		</CommandDialog>
	);
}

export function CommandPalette({ isOpen, onClose, commands }: CommandPaletteProps) {
	if (!isOpen) return null;
	return <CommandPaletteDialog onClose={onClose} commands={commands} />;
}
