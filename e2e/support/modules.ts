import { expect, type APIRequestContext } from "@playwright/test";

const MODULE_IDS = ["calendar", "booking", "templates", "import", "finance"] as const;
export type ModuleId = (typeof MODULE_IDS)[number];

type AccessChange = { userId: string; moduleId: ModuleId; allowed: boolean };

/**
 * Sets module state as the owner through the admin APIs (`PUT /api/admin/modules` and
 * `PUT /api/admin/accounts/<id>/modules`), the same calls the Modules page makes, which clear the
 * server's module cache so the change shows at once. Modules are changed in registry order, so a
 * restore turns Calendar on before Booking.
 */
export async function setModuleState(
	owner: APIRequestContext,
	change: { modules?: Partial<Record<ModuleId, boolean>>; access?: AccessChange[] },
): Promise<void> {
	for (const moduleId of MODULE_IDS) {
		const enabled = change.modules?.[moduleId];
		if (enabled === undefined) continue;
		const response = await owner.put("/api/admin/modules", { data: { moduleId, enabled } });
		expect(response.status(), await response.text()).toBe(200);
	}
	for (const { userId, moduleId, allowed } of change.access ?? []) {
		const response = await owner.put(`/api/admin/accounts/${userId}/modules`, { data: { moduleId, allowed } });
		expect(response.status(), await response.text()).toBe(200);
	}
}

/** Every module on and every named user allowed again, which each spec that changes state does in `finally`. */
export async function restoreModules(owner: APIRequestContext, restrictedUserIds: string[] = []): Promise<void> {
	await setModuleState(owner, {
		modules: Object.fromEntries(MODULE_IDS.map((id) => [id, true])),
		access: restrictedUserIds.flatMap((userId) => MODULE_IDS.map((moduleId) => ({ userId, moduleId, allowed: true }))),
	});
}
