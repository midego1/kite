"use client";

import { createContext, useContext, useMemo, type ReactNode } from "react";
import type { ModuleId } from "@/lib/modules/module-types";
import { MODULE_IDS } from "@/lib/modules/registry";

type ModulesState = {
	/** The modules that are on for the signed-in user, in registry order. */
	modules: readonly ModuleId[];
	isEnabled: (id: ModuleId) => boolean;
};

function stateFor(modules: readonly ModuleId[]): ModulesState {
	return { modules, isEnabled: (id) => modules.includes(id) };
}

// Outside a provider (public pages, tests) nothing is hidden: the server still decides.
const ModulesContext = createContext<ModulesState>(stateFor(MODULE_IDS));

/**
 * Feeds `useModules()` from the `modules` field of `/api/auth/me`. A display hint only: pages and
 * APIs answer 404 for a module that is off whatever the client believes.
 * `undefined` (no session yet, or a server from before modules) shows every module.
 */
export function ModulesProvider({
	modules,
	children,
}: {
	modules: readonly ModuleId[] | undefined;
	children: ReactNode;
}) {
	const value = useMemo(() => stateFor(modules ?? MODULE_IDS), [modules]);
	return <ModulesContext.Provider value={value}>{children}</ModulesContext.Provider>;
}

/**
 * The modules that are on for the signed-in user.
 * @public Consumed by the module-aware navigation and settings surfaces.
 */
export function useModules(): ModulesState {
	return useContext(ModulesContext);
}
