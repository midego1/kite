"use client";

import { useEffect, useRef } from "react";
import type { CommandHandler } from "@/lib/modules/module-types";
import { useShortcuts } from "./shortcuts-context";

/**
 * Offers `handler` to the palette as the handler of `commandId` while the calling component is mounted,
 * so a command that needs an open view is listed only while that view is open.
 * @public Used by views that own an action the palette can run.
 */
export function useCommandHandler(commandId: string, handler: CommandHandler) {
	const { registerCommandHandler } = useShortcuts();
	const latest = useRef(handler);
	useEffect(() => {
		latest.current = handler;
	}, [handler]);
	useEffect(
		() => registerCommandHandler(commandId, (context) => latest.current(context)),
		[commandId, registerCommandHandler],
	);
}
