import { expect, test } from "@playwright/test";
import { STORAGE_STATE } from "./support/constants";
import { okJson } from "./support/auto-read";
import {
	cronTick,
	financeAccount,
	isoDay,
	noticeFrames,
	openRealtimePage,
	reminderEvents,
	type SubscriptionView,
} from "./support/finance";
import { apiContext } from "./support/helpers";
import { restoreModules, setModuleState } from "./support/modules";

test("restricted owners cannot fill the reminder batch ahead of an enabled owner", async ({ browser }) => {
	test.slow();
	const admin = await apiContext(STORAGE_STATE);
	const blocked = await financeAccount(admin, "frb");
	const enabled = await financeAccount(admin, "fre");
	const { context, page } = await openRealtimePage(browser, enabled);
	const blockedIds: string[] = [];
	let enabledId: string | null = null;
	try {
		for (let index = 0; index < 100; index += 1) {
			const { subscription } = await okJson<{ subscription: SubscriptionView }>(
				await blocked.api.post("/api/finance/subscriptions", {
					data: {
						vendor: `Blocked renewal ${index}`,
						amountMinor: 100,
						currency: "USD",
						cycle: "monthly",
						nextRenewalOn: isoDay(0),
						reminderDays: 3,
						calendarReminder: false,
						mailboxId: blocked.mailboxId,
					},
				}),
			);
			blockedIds.push(subscription.id);
		}
		await setModuleState(admin, { access: [{ userId: blocked.id, moduleId: "finance", allowed: false }] });
		const { subscription } = await okJson<{ subscription: SubscriptionView }>(
			await enabled.api.post("/api/finance/subscriptions", {
				data: {
					vendor: "Enabled renewal",
					amountMinor: 100,
					currency: "USD",
					cycle: "monthly",
					nextRenewalOn: isoDay(1),
					reminderDays: 3,
					calendarReminder: true,
					mailboxId: enabled.mailboxId,
				},
			}),
		);
		enabledId = subscription.id;
		await cronTick(admin);
		await expect.poll(async () => (await noticeFrames(page)).length, { timeout: 20_000 }).toBe(1);
		expect((await noticeFrames(page))[0]).toMatchObject({
			notice: "renewal_due",
			href: `/finance?subscription=${enabledId}`,
		});
		expect(await reminderEvents(enabled, enabledId)).toHaveLength(1);
		await cronTick(admin);
		expect(await noticeFrames(page)).toHaveLength(1);
	} finally {
		await restoreModules(admin, [blocked.id, enabled.id]);
		for (const id of blockedIds) await okJson(await blocked.api.delete(`/api/finance/subscriptions/${id}`));
		if (enabledId) await okJson(await enabled.api.delete(`/api/finance/subscriptions/${enabledId}`));
		await context.close();
		await blocked.api.dispose();
		await enabled.api.dispose();
		await admin.dispose();
	}
});
