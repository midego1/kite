"use client";

import { useCallback, useEffect, useState } from "react";
import { loadModuleClient } from "@/components/modules/client-registry";
import { CLIENT_MODULES } from "@/lib/modules/client-data";
import type { CommandHandler, ModuleId } from "@/lib/modules/module-types";
import { handlersByCommandId } from "./command-palette-utils";

export type CommandHandlerRegistry = {
	/** Handlers mounted components registered, and those loaded from module chunks, by command id. */
	handlers: Record<string, CommandHandler>;
	register: (commandId: string, handler: CommandHandler) => () => void;
};

/**
 * Keeps the client handlers the palette can call. A mounted component adds one with `register`; the
 * client chunk of an enabled module is loaded the first time `loadModules` turns true, because the
 * palette lists a client command only while a handler for it exists.
 */
export function useCommandHandlerRegistry(enabled: readonly ModuleId[], loadModules: boolean): CommandHandlerRegistry {
	const [registered, setRegistered] = useState<Record<string, CommandHandler>>({});
	const [loaded, setLoaded] = useState<Record<string, CommandHandler>>({});

	useEffect(() => {
		if (!loadModules) return;
		let active = true;
		for (const source of CLIENT_MODULES) {
			const clientCommands = source.commands.filter((command) => command.target.type === "client");
			if (!enabled.includes(source.id) || clientCommands.length === 0) continue;
			loadModuleClient(source.id)
				?.then((client) => {
					if (active && client.commandHandlers)
						setLoaded((previous) => ({ ...previous, ...handlersByCommandId(clientCommands, client.commandHandlers!) }));
				})
				.catch(() => {});
		}
		return () => {
			active = false;
		};
	}, [enabled, loadModules]);

	const register = useCallback((commandId: string, handler: CommandHandler) => {
		setRegistered((previous) => ({ ...previous, [commandId]: handler }));
		return () =>
			setRegistered((previous) => {
				if (previous[commandId] !== handler) return previous;
				const next = { ...previous };
				delete next[commandId];
				return next;
			});
	}, []);

	return { handlers: { ...loaded, ...registered }, register };
}
