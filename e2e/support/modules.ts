import { expect, type APIRequestContext } from "@playwright/test";

const MODULE_IDS = ["calendar", "booking", "templates", "import"] as const;
export type ModuleId = (typeof MODULE_IDS)[number];

type AccessChange = { userId: string; moduleId: ModuleId; allowed: boolean };

/**
 * Sets module state as the owner through the development-only route (`/api/dev/modules`, which answers 404
 * in production builds). The route clears the server's module cache, so the change shows at once.
 */
export async function setModuleState(
	owner: APIRequestContext,
	change: { modules?: Partial<Record<ModuleId, boolean>>; access?: AccessChange[] },
): Promise<void> {
	const response = await owner.put("/api/dev/modules", { data: change });
	expect(response.status(), await response.text()).toBe(200);
}

/** Every module on and every named user allowed again, which each spec that changes state does in `finally`. */
export async function restoreModules(owner: APIRequestContext, restrictedUserIds: string[] = []): Promise<void> {
	await setModuleState(owner, {
		modules: Object.fromEntries(MODULE_IDS.map((id) => [id, true])),
		access: restrictedUserIds.flatMap((userId) => MODULE_IDS.map((moduleId) => ({ userId, moduleId, allowed: true }))),
	});
}
