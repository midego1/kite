"use client";

import React, { useState, useEffect, useRef, useMemo } from "react";
import { Search, CornerDownLeft } from "lucide-react";
import toast from "react-hot-toast";
import type { CommandItem } from "./types";
import { CommandParamForm } from "./command-palette-params";
import { filterCommands, groupCommandsByCategory, orderCommandsByGroup } from "./command-palette-utils";
import { CommandPaletteItem } from "./command-palette-item";

interface CommandPaletteProps {
	isOpen: boolean;
	onClose: () => void;
	commands: CommandItem[];
}

function CommandPaletteDialog({ onClose, commands }: { onClose: () => void; commands: CommandItem[] }) {
	const [query, setQuery] = useState("");
	const [selectedIndex, setSelectedIndex] = useState(0);
	const inputRef = useRef<HTMLInputElement>(null);
	const [pending, setPending] = useState<CommandItem | null>(null);
	const [values, setValues] = useState<Record<string, string>>({});
	const [paramError, setParamError] = useState<string | null>(null);

	useEffect(() => {
		inputRef.current?.focus();
	}, []);

	const filteredCommands = useMemo(() => filterCommands(commands, query), [commands, query]);

	const grouped = useMemo(() => groupCommandsByCategory(filteredCommands), [filteredCommands]);
	const orderedCommands = useMemo(() => orderCommandsByGroup(filteredCommands), [filteredCommands]);

	const activeIndex = Math.min(selectedIndex, Math.max(0, orderedCommands.length - 1));

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

	const handleKeyDown = (e: React.KeyboardEvent) => {
		if (pending) {
			if (e.key === "Enter") {
				e.preventDefault();
				void submitParams();
			} else if (e.key === "Escape") {
				e.preventDefault();
				setPending(null);
			}
			return;
		}
		if (e.key === "ArrowDown") {
			e.preventDefault();
			setSelectedIndex((prev) => (prev + 1) % (orderedCommands.length || 1));
		} else if (e.key === "ArrowUp") {
			e.preventDefault();
			setSelectedIndex((prev) => (prev - 1 + orderedCommands.length) % (orderedCommands.length || 1));
		} else if (e.key === "Enter") {
			e.preventDefault();
			if (orderedCommands[activeIndex]) select(orderedCommands[activeIndex]);
		} else if (e.key === "Escape") {
			e.preventDefault();
			onClose();
		}
	};

	let flatIndex = 0;

	return (
		<div className="fixed inset-0 z-50 flex items-start justify-center pt-24 px-4 bg-neutral-900/40 backdrop-blur-xs animate-in fade-in duration-100">
			<div className="fixed inset-0" onClick={onClose} aria-hidden="true" />
			<div
				className="relative w-full max-w-xl bg-white border border-neutral-200 rounded-2xl shadow-2xl overflow-hidden flex flex-col z-10"
				onKeyDown={handleKeyDown}
			>
				{/* Search header */}
				<div className="flex items-center px-4 py-3.5 border-b border-neutral-100 gap-3">
					<Search className="w-5 h-5 text-neutral-400" />
					<input
						ref={inputRef}
						type="text"
						disabled={pending !== null}
						value={query}
						onChange={(e) => {
							setQuery(e.target.value);
							setSelectedIndex(0);
						}}
						placeholder="Type a command or search actions..."
						className="w-full bg-transparent text-neutral-900 placeholder-neutral-400 text-[15px] focus:outline-none"
					/>
					<kbd className="px-2 py-0.5 text-xs font-semibold text-neutral-400 bg-neutral-100 border border-neutral-200 rounded-md shadow-2xs">
						ESC
					</kbd>
				</div>

				{/* Results */}
				<div className="max-h-80 overflow-y-auto p-2">
					{pending ? (
						<CommandParamForm
							item={pending}
							values={values}
							error={paramError}
							onChange={(name, value) => setValues((previous) => ({ ...previous, [name]: value }))}
						/>
					) : filteredCommands.length === 0 ? (
						<div className="p-8 text-center text-sm text-neutral-400">
							No matching commands found for &ldquo;{query}&rdquo;
						</div>
					) : (
						Object.entries(grouped).map(([category, items]) => (
							<div key={category} className="mb-2 last:mb-0">
								<div className="px-3 py-1 text-[11px] font-semibold uppercase tracking-wider text-neutral-400">
									{category}
								</div>
								{items.map((item) => {
									const isCurrent = flatIndex === activeIndex;
									const itemIndex = flatIndex;
									flatIndex++;

									return (
										<CommandPaletteItem
											key={item.id}
											item={item}
											isActive={isCurrent}
											onSelect={() => select(item)}
											onHover={() => setSelectedIndex(itemIndex)}
										/>
									);
								})}
							</div>
						))
					)}
				</div>

				{/* Footer */}
				<div className="px-4 py-2.5 bg-neutral-50 border-t border-neutral-100 flex items-center justify-between text-xs text-neutral-400">
					<div className="flex items-center gap-3">
						<span>
							<kbd className="px-1.5 py-0.5 bg-neutral-200 rounded mr-1 text-[10px]">↑↓</kbd>
							to navigate
						</span>
						<span className="flex items-center">
							<CornerDownLeft className="w-3 h-3 mr-1 inline" />
							to select
						</span>
					</div>
					<span className="text-[11px]">Kite Actions</span>
				</div>
			</div>
		</div>
	);
}

export function CommandPalette({ isOpen, onClose, commands }: CommandPaletteProps) {
	if (!isOpen) return null;
	return <CommandPaletteDialog onClose={onClose} commands={commands} />;
}
