"use client";

import React, { createContext, useCallback, useContext, useState, useMemo } from "react";
import { useRouter } from "next/navigation";
import toast from "react-hot-toast";
import { useCompose } from "@/components/compose/compose-context";
import { useModules } from "@/components/modules/modules-context";
import type { CommandHandler, CommandParamValues, CoreShortcutChrome, UiCommand } from "@/lib/modules/module-types";
import type { ShortcutDefinition, CommandItem } from "./types";
import { COMMAND_ICONS } from "./command-icons";
import { useCommandHandlerRegistry } from "./command-handlers";
import { LazyCommandPalette } from "./command-palette-lazy";
import { commandParamFields, listCommands, listShortcutBindings, runCommand } from "./command-palette-utils";
import { useHotkeys } from "./use-hotkeys";
import { ShortcutsHelpDialog } from "./shortcuts-help-dialog";
import { useShortcutsEnabled } from "./use-shortcuts-enabled";
import { withMailKeyHints } from "./mail-key-hints-utils";

interface ShortcutsContextValue {
	shortcutsEnabled: boolean;
	shortcutsPreferenceLoading: boolean;
	shortcutsPreferenceError: string | null;
	setShortcutsEnabled: (enabled: boolean) => Promise<void>;
	openCommandPalette: () => void;
	closeCommandPalette: () => void;
	openHelpModal: () => void;
	closeHelpModal: () => void;
	registerShortcut: (shortcut: ShortcutDefinition) => void;
	registerCommand: (command: CommandItem) => void;
	/** Offers a handler for a client command until the returned function is called. */
	registerCommandHandler: (commandId: string, handler: CommandHandler) => () => void;
	shortcuts: ShortcutDefinition[];
	commands: CommandItem[];
}

const ShortcutsContext = createContext<ShortcutsContextValue | null>(null);

export function useShortcuts() {
	const ctx = useContext(ShortcutsContext);
	if (!ctx) {
		throw new Error("useShortcuts must be used within a ShortcutsProvider");
	}
	return ctx;
}

export function ShortcutsProvider({
	children,
	extraShortcuts = [],
	extraCommands = [],
}: {
	children: React.ReactNode;
	extraShortcuts?: ShortcutDefinition[];
	extraCommands?: CommandItem[];
}) {
	const router = useRouter();
	const { openComposer } = useCompose();
	const { modules } = useModules();
	const {
		enabled: shortcutsEnabled,
		error: shortcutsPreferenceError,
		isLoading: shortcutsPreferenceLoading,
		setEnabled: setShortcutsEnabled,
	} = useShortcutsEnabled();

	const [isCommandPaletteOpen, setIsCommandPaletteOpen] = useState(false);
	const [isHelpModalOpen, setIsHelpModalOpen] = useState(false);
	const [customShortcuts, setCustomShortcuts] = useState<ShortcutDefinition[]>(extraShortcuts);
	const [customCommands, setCustomCommands] = useState<CommandItem[]>(extraCommands);

	const openCommandPalette = () => {
		if (shortcutsEnabled && !shortcutsPreferenceLoading) setIsCommandPaletteOpen(true);
	};
	const closeCommandPalette = () => setIsCommandPaletteOpen(false);
	const openHelpModal = () => {
		if (shortcutsEnabled && !shortcutsPreferenceLoading) setIsHelpModalOpen(true);
	};
	const closeHelpModal = () => setIsHelpModalOpen(false);

	const registerShortcut = (shortcut: ShortcutDefinition) => {
		setCustomShortcuts((prev) => {
			const idx = prev.findIndex((s) => s.key === shortcut.key);
			if (idx >= 0) {
				const next = [...prev];
				next[idx] = shortcut;
				return next;
			}
			return [...prev, shortcut];
		});
	};

	const registerCommand = (command: CommandItem) => {
		setCustomCommands((prev) => {
			const idx = prev.findIndex((c) => c.id === command.id);
			if (idx >= 0) {
				const next = [...prev];
				next[idx] = command;
				return next;
			}
			return [...prev, command];
		});
	};

	const { handlers: clientHandlers, register: registerCommandHandler } = useCommandHandlerRegistry(
		modules,
		isCommandPaletteOpen,
	);
	const coreHandlers = useMemo<Record<string, CommandHandler>>(
		() => ({ compose: () => openComposer(), "show-help": () => setIsHelpModalOpen(true) }),
		[openComposer],
	);
	const handlers = useMemo(() => ({ ...clientHandlers, ...coreHandlers }), [clientHandlers, coreHandlers]);

	// What the palette and the key bindings may offer: core's commands and those of the modules that
	// are on, so a disabled module's commands and shortcuts are absent whichever layout mounts this.
	const commands = useMemo(
		() => listCommands({ enabled: modules, handlers: Object.keys(handlers) }),
		[modules, handlers],
	);

	const perform = useCallback(
		async (command: UiCommand, values?: CommandParamValues) => {
			const result = await runCommand(command, { navigate: (href) => router.push(href), handlers }, values);
			return result.ok ? undefined : result.error;
		},
		[router, handlers],
	);

	const baseShortcuts = useMemo<ShortcutDefinition[]>(() => {
		const chrome: Record<CoreShortcutChrome, () => void> = {
			togglePalette: () => setIsCommandPaletteOpen((prev) => !prev),
			toggleHelp: () => setIsHelpModalOpen((prev) => !prev),
			focusSearch: () => {
				const searchInput = document.querySelector<HTMLInputElement>('input[placeholder*="Search"]');
				if (searchInput) {
					searchInput.focus();
					searchInput.select();
				}
			},
			dismiss: () => {
				setIsCommandPaletteOpen(false);
				setIsHelpModalOpen(false);
			},
		};
		const bound = listShortcutBindings(commands).map((binding): ShortcutDefinition => {
			const command = commands.find((item) => item.id === binding.commandId);
			return {
				key: binding.key,
				label: binding.label,
				category: binding.category,
				modifiers: binding.modifiers,
				action: () => {
					if (binding.chrome) chrome[binding.chrome]();
					else if (command) void perform(command).then((message) => message && toast.error(message));
				},
			};
		});
		return [...bound, ...customShortcuts];
	}, [commands, perform, customShortcuts]);

	useHotkeys(baseShortcuts, { enabled: shortcutsEnabled && !shortcutsPreferenceLoading });
	const helpShortcuts = useMemo(() => withMailKeyHints(baseShortcuts), [baseShortcuts]);

	const allCommands = useMemo<CommandItem[]>(() => {
		const items = commands.map((command): CommandItem => {
			const fields = commandParamFields(command);
			return {
				id: command.id,
				title: command.label,
				subtitle: command.group === "Navigation" ? undefined : command.description,
				category: command.group,
				icon: COMMAND_ICONS[command.id],
				shortcut: command.shortcut,
				keywords: command.keywords,
				params: fields.length ? fields : undefined,
				perform: (values) => perform(command, values),
			};
		});
		return [...items, ...customCommands];
	}, [commands, perform, customCommands]);

	return (
		<ShortcutsContext.Provider
			value={{
				shortcutsEnabled,
				shortcutsPreferenceLoading,
				shortcutsPreferenceError,
				setShortcutsEnabled,
				openCommandPalette,
				closeCommandPalette,
				openHelpModal,
				closeHelpModal,
				registerShortcut,
				registerCommand,
				registerCommandHandler,
				shortcuts: baseShortcuts,
				commands: allCommands,
			}}
		>
			{children}
			{shortcutsEnabled && !shortcutsPreferenceLoading && (
				<>
					{isCommandPaletteOpen && <LazyCommandPalette isOpen onClose={closeCommandPalette} commands={allCommands} />}
					<ShortcutsHelpDialog isOpen={isHelpModalOpen} onClose={closeHelpModal} shortcuts={helpShortcuts} />
				</>
			)}
		</ShortcutsContext.Provider>
	);
}
