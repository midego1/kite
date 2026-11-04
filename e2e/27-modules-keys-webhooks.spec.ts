import { expect, test, type APIRequestContext, type Locator } from "@playwright/test";
import { firstMailboxId } from "./support/chat";
import { uniqueToken } from "./support/helpers";
import { callOutcome, createMcpKey, mcpCall, mcpToolNames } from "./support/mcp";
import { restoreModules, setModuleState } from "./support/modules";
import {
	CALENDAR_EVENTS,
	CALENDAR_MCP_TOOLS,
	CALENDAR_SCOPES,
	FINANCE_EVENTS,
	createMember,
	deleteKeys,
	expectEveryModuleOn,
	moduleSwitch,
	owner,
	ownerBooking,
	visitor,
} from "./support/module-spec";

const CALENDAR_READ_TOOLS = ["find_free_time", "get_calendars", "get_event", "get_schedule", "search_events"];

async function mailboxIdOf(api: APIRequestContext): Promise<string> {
	return firstMailboxId(api);
}

test("MCP lists the calendar tools only while Calendar is on for the key's user, and an old key gets them back", async () => {
	const api = await owner();
	const rpcApi = await visitor();
	const created: string[] = [];
	let member: Awaited<ReturnType<typeof createMember>> | null = null;
	try {
		const mailboxId = await mailboxIdOf(api);
		const full = await createMcpKey(api, "E2E module tools", ["mcp:read", ...CALENDAR_SCOPES], [mailboxId]);
		created.push(full.id);

		const before = await mcpToolNames(rpcApi, full.key);
		expect(before).toEqual(expect.arrayContaining([...CALENDAR_MCP_TOOLS, "list_mailboxes", "list_emails"]));

		await setModuleState(api, { modules: { calendar: false } });
		const init = await mcpCall(rpcApi, full.key, "initialize", {
			protocolVersion: "2025-06-18",
			capabilities: {},
			clientInfo: { name: "kite-e2e", version: "1.0.0" },
		});
		expect(init.error).toBeUndefined();
		const off = await mcpToolNames(rpcApi, full.key);
		for (const tool of CALENDAR_MCP_TOOLS) expect(off, tool).not.toContain(tool);
		expect(off).toEqual(expect.arrayContaining(["list_mailboxes", "list_emails", "search_emails"]));

		const listed = (await (await api.get("/api/agent/mcp-keys")).json()) as {
			keys: { id: string; scopes: string }[];
		};
		expect(JSON.parse(listed.keys.find((key) => key.id === full.id)!.scopes)).toEqual(["mcp:read", ...CALENDAR_SCOPES]);

		const title = uniqueToken("mcp-off");
		const unknown = await mcpCall(rpcApi, full.key, "tools/call", { name: "no_such_tool", arguments: {} });
		expect(unknown.error ?? unknown.result?.isError).toBeTruthy();
		const schedule = await mcpCall(rpcApi, full.key, "tools/call", {
			name: "get_schedule",
			arguments: { start: "2030-01-01T00:00:00Z", end: "2030-01-08T00:00:00Z" },
		});
		const create = await mcpCall(rpcApi, full.key, "tools/call", {
			name: "create_event",
			arguments: { title, startsAt: "2030-01-02T10:00:00Z", endsAt: "2030-01-02T11:00:00Z" },
		});
		for (const [name, response] of [
			["get_schedule", schedule],
			["create_event", create],
		] as const) {
			expect(callOutcome(response, name), name).toBe(callOutcome(unknown, "no_such_tool"));
		}

		await setModuleState(api, { modules: { calendar: true } });
		expect(await mcpToolNames(rpcApi, full.key)).toEqual(before);
		const made = await mcpCall(rpcApi, full.key, "tools/call", {
			name: "create_event",
			arguments: { title, startsAt: "2030-01-02T10:00:00Z", endsAt: "2030-01-02T11:00:00Z" },
		});
		expect(made.result?.isError, JSON.stringify(made)).toBeFalsy();
		const events = (await (
			await api.get("/api/calendar/events?start=2030-01-01T00:00:00Z&end=2030-01-08T00:00:00Z")
		).json()) as { events: { id: string; title: string }[] };
		expect(events.events.filter((event) => event.title === title)).toHaveLength(1);
		const eventId = events.events.find((event) => event.title === title)!.id;
		await api.delete(`/api/calendar/events/${eventId}`);

		member = await createMember(api);
		const memberKey = await createMcpKey(
			member.api,
			"E2E member tools",
			["mcp:read", ...CALENDAR_SCOPES],
			[await mailboxIdOf(member.api)],
		);
		created.push(memberKey.id);
		expect(await mcpToolNames(rpcApi, memberKey.key)).toEqual(expect.arrayContaining(CALENDAR_MCP_TOOLS));
		await setModuleState(api, { access: [{ userId: member.id, moduleId: "calendar", allowed: false }] });
		const restricted = await mcpToolNames(rpcApi, memberKey.key);
		for (const tool of CALENDAR_MCP_TOOLS) expect(restricted, tool).not.toContain(tool);
		expect(restricted).toContain("list_mailboxes");
		expect(await mcpToolNames(rpcApi, full.key)).toEqual(expect.arrayContaining(CALENDAR_MCP_TOOLS));
	} finally {
		await restoreModules(api, member ? [member.id] : []);
		await deleteKeys(api, { mcp: created });
		if (member) await deleteKeys(member.api, { mcp: created });
		await member?.api.dispose();
		await rpcApi.dispose();
		await api.dispose();
	}
});

test("calendar MCP scopes need no mailbox and the read scope lists only the read tools", async () => {
	const api = await owner();
	const rpcApi = await visitor();
	const created: string[] = [];
	try {
		const read = await createMcpKey(api, "E2E calendar read", ["mcp:calendar-read"], []);
		const write = await createMcpKey(api, "E2E calendar write", ["mcp:calendar-write"], []);
		created.push(read.id, write.id);
		expect(await mcpToolNames(rpcApi, read.key)).toEqual(CALENDAR_READ_TOOLS);
		expect(await mcpToolNames(rpcApi, write.key)).toEqual(CALENDAR_MCP_TOOLS);

		const mailOnly = await api.post("/api/agent/mcp-keys", {
			data: { name: "E2E no mailbox", mailboxIds: [], scopes: ["mcp:read"] },
		});
		expect(mailOnly.status()).toBe(400);
		expect(await mailOnly.json()).toEqual({ error: "Choose a mailbox for mail permissions" });
	} finally {
		await deleteKeys(api, { mcp: created });
		await rpcApi.dispose();
		await api.dispose();
	}
});

test("creating a key with a disabled module's scope answers 400 MODULE_DISABLED, and core scopes still work", async () => {
	const api = await owner();
	let member: Awaited<ReturnType<typeof createMember>> | null = null;
	const created = { mcp: [] as string[], api: [] as string[] };
	const keyCount = async () => {
		const mcp = (await (await api.get("/api/agent/mcp-keys")).json()) as { keys: unknown[] };
		const standard = (await (await api.get("/api/api-keys")).json()) as { apiKeys: unknown[] };
		return mcp.keys.length + standard.apiKeys.length;
	};
	try {
		const mailboxId = await mailboxIdOf(api);
		const refuse = async (caller: APIRequestContext, path: string, data: Record<string, unknown>) => {
			const response = await caller.post(path, { data });
			expect(response.status(), await response.text()).toBe(400);
			expect(await response.json()).toMatchObject({ code: "MODULE_DISABLED", moduleId: "calendar" });
		};

		await setModuleState(api, { modules: { calendar: false } });
		const before = await keyCount();
		await refuse(api, "/api/agent/mcp-keys", { name: "off", mailboxIds: [], scopes: ["mcp:calendar-read"] });
		await refuse(api, "/api/agent/mcp-keys", {
			name: "off",
			mailboxIds: [mailboxId],
			scopes: ["mcp:read", "mcp:calendar-write"],
		});
		await refuse(api, "/api/api-keys", { name: "off", mailboxIds: [], scopes: ["calendar:read"] });
		await refuse(api, "/api/api-keys", { name: "off", mailboxIds: [mailboxId], scopes: ["read", "calendar:write"] });
		expect(await keyCount()).toBe(before);

		const core = await api.post("/api/api-keys", {
			data: { name: "E2E core while off", mailboxIds: [mailboxId], scopes: ["read"] },
		});
		expect(core.status(), await core.text()).toBe(200);
		created.api.push(((await core.json()) as { id: string }).id);
		const unknown = await api.post("/api/api-keys", {
			data: { name: "x", mailboxIds: [mailboxId], scopes: ["foo:bar"] },
		});
		expect(unknown.status()).toBe(400);
		expect(await unknown.json()).not.toHaveProperty("code");

		await setModuleState(api, { modules: { calendar: true } });
		const mcp = await api.post("/api/agent/mcp-keys", {
			data: { name: "E2E calendar on", mailboxIds: [], scopes: ["mcp:calendar-read"] },
		});
		expect(mcp.status(), await mcp.text()).toBe(200);
		created.mcp.push(((await mcp.json()) as { id: string }).id);
		const standard = await api.post("/api/api-keys", {
			data: { name: "E2E calendar rest on", mailboxIds: [], scopes: ["calendar:read"] },
		});
		expect(standard.status(), await standard.text()).toBe(200);
		created.api.push(((await standard.json()) as { id: string }).id);

		member = await createMember(api);
		await setModuleState(api, { access: [{ userId: member.id, moduleId: "calendar", allowed: false }] });
		await refuse(member.api, "/api/agent/mcp-keys", { name: "off", mailboxIds: [], scopes: ["mcp:calendar-read"] });
		await refuse(member.api, "/api/api-keys", { name: "off", mailboxIds: [], scopes: ["calendar:write"] });
	} finally {
		await restoreModules(api, member ? [member.id] : []);
		await deleteKeys(api, created);
		await member?.api.dispose();
		await api.dispose();
	}
});

test("the REST calendar answers 404 to a calendar key while Calendar is off and works again when it is on", async () => {
	const api = await owner();
	const keyed = await visitor();
	const created: string[] = [];
	try {
		const key = await api.post("/api/api-keys", {
			data: { name: "E2E calendar rest", mailboxIds: [], scopes: ["calendar:read", "calendar:write"] },
		});
		expect(key.status(), await key.text()).toBe(200);
		const { id, key: secret } = (await key.json()) as { id: string; key: string };
		created.push(id);
		const headers = { Authorization: `Bearer ${secret}` };
		const title = uniqueToken("rest-key");
		const body = { title, startsAt: "2030-02-02T10:00:00Z", endsAt: "2030-02-02T11:00:00Z" };

		expect((await keyed.get("/api/calendar/events", { headers })).status()).toBe(200);

		await setModuleState(api, { modules: { calendar: false } });
		const list = await keyed.get("/api/calendar/events", { headers });
		expect(list.status()).toBe(404);
		expect(await list.json()).toEqual({ error: "Not found" });
		const post = await keyed.post("/api/calendar/events", { headers, data: body });
		expect(post.status()).toBe(404);
		const keys = (await (await api.get("/api/api-keys")).json()) as { apiKeys: { id: string; scopes: string }[] };
		expect(JSON.parse(keys.apiKeys.find((item) => item.id === id)!.scopes)).toEqual([
			"calendar:read",
			"calendar:write",
		]);

		await setModuleState(api, { modules: { calendar: true } });
		expect((await keyed.get("/api/calendar/events", { headers })).status()).toBe(200);
		const made = await keyed.post("/api/calendar/events", { headers, data: body });
		expect(made.status(), await made.text()).toBeLessThan(300);
		const eventId = ((await made.json()) as { event?: { id: string }; id?: string }).event?.id;
		if (eventId) await api.delete(`/api/calendar/events/${eventId}`);
	} finally {
		await restoreModules(api);
		await deleteKeys(api, { api: created });
		await keyed.dispose();
		await api.dispose();
	}
});

test("the key forms list calendar scopes only while Calendar is on, and existing keys keep theirs", async ({
	page,
}) => {
	const api = await owner();
	const created = { mcp: [] as string[], api: [] as string[] };
	const optionNames = async () => {
		await page.goto("/settings/api-keys");
		await page.getByRole("button", { name: "New API key" }).click();
		const dialog = page.getByRole("dialog");
		const standard = await dialog.getByRole("group", { name: "Permissions" }).locator("strong").allTextContents();
		await dialog.getByRole("checkbox", { name: /Allow MCP access/ }).check();
		const mcp = await dialog.getByRole("group", { name: "Permissions" }).locator("strong").allTextContents();
		return { standard, mcp };
	};
	try {
		const mailboxId = await mailboxIdOf(api);
		const made = await createMcpKey(api, "E2E form keeps scopes", ["mcp:calendar-read"], []);
		created.mcp.push(made.id);
		const rest = await api.post("/api/api-keys", {
			data: { name: "E2E form rest key", mailboxIds: [mailboxId], scopes: ["read", "calendar:read"] },
		});
		created.api.push(((await rest.json()) as { id: string }).id);

		const on = await optionNames();
		expect(on.standard).toEqual(["Read mail", "Send mail", "Read calendar", "Manage calendar"]);
		expect(on.mcp).toEqual([
			"Read mail",
			"Manage drafts",
			"Organize mail",
			"Request send review",
			"Read calendar",
			"Manage calendar",
			"Read subscriptions",
		]);

		await setModuleState(api, { modules: { calendar: false } });
		const off = await optionNames();
		expect(off.standard).toEqual(["Read mail", "Send mail"]);
		expect(off.mcp).toEqual([
			"Read mail",
			"Manage drafts",
			"Organize mail",
			"Request send review",
			"Read subscriptions",
		]);
		await page.keyboard.press("Escape");
		const row = page.getByText("E2E form keeps scopes").locator("xpath=ancestor::span[contains(@class,'flex-1')][1]");
		await expect(row.getByText("mcp:calendar-read", { exact: true })).toBeVisible();
		await expect(
			page
				.getByText("E2E form rest key")
				.locator("xpath=ancestor::span[contains(@class,'flex-1')][1]")
				.getByText("calendar:read", { exact: true }),
		).toBeVisible();

		await setModuleState(api, { modules: { calendar: true } });
		expect((await optionNames()).standard).toContain("Read calendar");
	} finally {
		await restoreModules(api);
		await deleteKeys(api, created);
		await api.dispose();
	}
});

async function deleteWebhooks(api: APIRequestContext, ids: string[]) {
	for (const id of ids) await api.delete(`/api/webhooks/${id}`);
}

const CALENDAR_EVENT_LABELS = ["Calendar event created", "Calendar event updated", "Calendar event deleted"];

const FINANCE_EVENT_LABELS = ["Subscription detected", "Subscription renewal due"];

test("the webhook picker lists calendar and booking events only while their modules are on", async ({ page }) => {
	const api = await owner();
	const eventLabels = async () => {
		await page.goto("/webhooks");
		await page.getByRole("button", { name: "Add endpoint" }).click();
		const dialog = page.getByRole("dialog");
		await expect(dialog.getByText("Inbound message", { exact: true })).toBeVisible();
		return dialog.locator("label span.font-medium").allTextContents();
	};
	try {
		const on = await eventLabels();
		expect(on).toEqual([
			"Inbound message",
			"Outbound message",
			"Delivery failure",
			...CALENDAR_EVENT_LABELS,
			"Appointment booked",
			...FINANCE_EVENT_LABELS,
		]);

		await setModuleState(api, { modules: { finance: false } });
		expect(await eventLabels()).toEqual([
			"Inbound message",
			"Outbound message",
			"Delivery failure",
			...CALENDAR_EVENT_LABELS,
			"Appointment booked",
		]);
		await setModuleState(api, { modules: { booking: false } });
		expect(await eventLabels()).toEqual([
			"Inbound message",
			"Outbound message",
			"Delivery failure",
			...CALENDAR_EVENT_LABELS,
		]);

		await setModuleState(api, { modules: { calendar: false } });
		expect(await eventLabels()).toEqual(["Inbound message", "Outbound message", "Delivery failure"]);
		const catalog = async () =>
			((await (await api.get("/api/webhooks")).json()) as { eventCatalog: Record<string, unknown>[] }).eventCatalog.map(
				(event) => event.value,
			);
		expect(await catalog()).toEqual(["message.inbound", "message.outbound", "message.failed"]);
		await setModuleState(api, { modules: { calendar: true } });
		expect(await catalog()).toEqual(["message.inbound", "message.outbound", "message.failed", ...CALENDAR_EVENTS]);
		await setModuleState(api, { modules: { booking: true } });
		expect(await catalog()).toEqual([
			"message.inbound",
			"message.outbound",
			"message.failed",
			...CALENDAR_EVENTS,
			"booking.appointment.created",
		]);
		await setModuleState(api, { modules: { finance: true } });
		expect(await catalog()).toEqual([
			"message.inbound",
			"message.outbound",
			"message.failed",
			...CALENDAR_EVENTS,
			"booking.appointment.created",
			...FINANCE_EVENTS,
		]);
	} finally {
		await restoreModules(api);
		await api.dispose();
	}
});

test("the webhook picker follows module changes made through the admin navigation", async ({ page }) => {
	const api = await owner();
	const created: string[] = [];
	const menu = page.getByRole("complementary", { name: "Admin menu" });
	const openPicker = async () => {
		await menu.getByRole("link", { name: "Webhooks", exact: true }).click();
		await expect(page.getByRole("heading", { level: 1, name: "Webhooks" })).toBeVisible();
		await page.getByRole("button", { name: "Add endpoint" }).click();
		const dialog = page.getByRole("dialog");
		await expect(dialog.getByText("Inbound message", { exact: true })).toBeVisible();
		return dialog;
	};
	const labels = (dialog: Locator) => dialog.locator("label span.font-medium").allTextContents();
	try {
		// Only Calendar changes here, so the picker shows exactly the core events once it is off.
		await setModuleState(api, { modules: { finance: false } });
		await page.goto("/webhooks");
		let dialog = await openPicker();
		expect(await labels(dialog)).toContain("Calendar event created");
		await page.keyboard.press("Escape");

		await menu.getByRole("link", { name: "Modules", exact: true }).click();
		await expect(page.getByRole("heading", { level: 1, name: "Modules" })).toBeVisible();
		await moduleSwitch(page, "Calendar").click();
		await page.getByRole("alertdialog").getByRole("button", { name: "Turn off Calendar" }).click();
		await expect(moduleSwitch(page, "Calendar")).not.toBeChecked();

		dialog = await openPicker();
		expect(await labels(dialog)).toEqual(["Inbound message", "Outbound message", "Delivery failure"]);
		await dialog.getByLabel("Endpoint URL").fill("https://hooks.e2e-modules.invalid/navigation");
		await dialog.getByRole("button", { name: "Create" }).click();
		await expect(dialog).toHaveCount(0);
		const made = (await (await api.get("/api/webhooks")).json()) as { webhooks: { id: string; events: string[] }[] };
		const mine = made.webhooks.find((hook) => hook.events.length === 3);
		expect(mine?.events).toEqual(["message.inbound", "message.outbound", "message.failed"]);
		if (mine) created.push(mine.id);

		await menu.getByRole("link", { name: "Modules", exact: true }).click();
		await expect(page.getByRole("heading", { level: 1, name: "Modules" })).toBeVisible();
		await moduleSwitch(page, "Calendar").click();
		await expect(moduleSwitch(page, "Calendar")).toBeChecked();
		dialog = await openPicker();
		expect(await labels(dialog)).toContain("Calendar event created");
	} finally {
		await restoreModules(api);
		await deleteWebhooks(api, created);
		await api.dispose();
	}
});

test("a webhook for a disabled module's event is refused with MODULE_DISABLED, and existing subscriptions keep it", async () => {
	const api = await owner();
	const created: string[] = [];
	const url = "https://hooks.e2e-modules.invalid/receiver";
	try {
		await setModuleState(api, { modules: { calendar: false } });
		const refused = await api.post("/api/webhooks", { data: { url, events: ["calendar.event.created"] } });
		expect(refused.status(), await refused.text()).toBe(400);
		expect(await refused.json()).toMatchObject({ code: "MODULE_DISABLED", moduleId: "calendar" });
		const mixed = await api.post("/api/webhooks", {
			data: { url, events: ["message.inbound", "calendar.event.deleted"] },
		});
		expect(mixed.status()).toBe(400);
		const core = await api.post("/api/webhooks", { data: { url, events: ["message.inbound"] } });
		expect(core.status(), await core.text()).toBeLessThan(300);

		await setModuleState(api, { modules: { calendar: true } });
		const made = await api.post("/api/webhooks", {
			data: { url, events: ["message.inbound", "calendar.event.created"] },
		});
		expect(made.status(), await made.text()).toBeLessThan(300);
		created.push(((await made.json()) as { id: string }).id);
		const coreId = (
			(await (await api.get("/api/webhooks")).json()) as { webhooks: { id: string; url: string; events: string[] }[] }
		).webhooks.find((hook) => hook.events.length === 1 && hook.events[0] === "message.inbound" && hook.url === url)?.id;
		if (coreId) created.push(coreId);

		await setModuleState(api, { modules: { calendar: false } });
		const edited = await api.patch(`/api/webhooks/${created[0]}`, { data: { description: "kept while off" } });
		expect(edited.status(), await edited.text()).toBeLessThan(300);
		const same = await api.patch(`/api/webhooks/${created[0]}`, {
			data: { events: ["message.inbound", "calendar.event.created"] },
		});
		expect(same.status(), await same.text()).toBeLessThan(300);
		const added = await api.patch(`/api/webhooks/${created[0]}`, {
			data: { events: ["message.inbound", "calendar.event.created", "calendar.event.updated"] },
		});
		expect(added.status()).toBe(400);
		expect(await added.json()).toMatchObject({ code: "MODULE_DISABLED" });
		const after = (await (await api.get("/api/webhooks")).json()) as {
			webhooks: { id: string; events: string[] }[];
			eventCatalog: { value: string }[];
		};
		expect(after.eventCatalog.map((event) => event.value)).not.toContain("calendar.event.created");
		expect(after.webhooks.find((hook) => hook.id === created[0])?.events).toEqual([
			"message.inbound",
			"calendar.event.created",
		]);
	} finally {
		await restoreModules(api);
		await deleteWebhooks(api, created);
		await api.dispose();
	}
});

type DeliveryRow = { id: string; eventType: string; status: string; error: string | null; payload: string };

async function deliveriesOf(api: APIRequestContext, webhookId: string): Promise<DeliveryRow[]> {
	const response = await api.get(`/api/webhooks/${webhookId}/deliveries?limit=100`);
	return ((await response.json()) as { deliveries: DeliveryRow[] }).deliveries;
}

test("calendar writes and public bookings emit one webhook delivery each with refs, nothing while off, and a dropped retry says why", async () => {
	const api = await owner();
	const visitorApi = await visitor();
	const cleanup = { webhooks: [] as string[], events: [] as string[], bookings: [] as string[] };
	try {
		const made = await api.post("/api/webhooks", {
			data: {
				url: "https://hooks.e2e-modules.invalid/deliveries",
				events: [
					"calendar.event.created",
					"calendar.event.updated",
					"calendar.event.deleted",
					"booking.appointment.created",
				],
				maxAttempts: 2,
			},
		});
		expect(made.status(), await made.text()).toBeLessThan(300);
		const hookId = ((await made.json()) as { id: string }).id;
		cleanup.webhooks.push(hookId);

		const title = uniqueToken("hook-event");
		const created = await api.post("/api/calendar/events", {
			data: { title, startsAt: "2031-05-05T10:00:00Z", endsAt: "2031-05-05T11:00:00Z" },
		});
		const eventId = ((await created.json()) as { event: { id: string } }).event.id;
		cleanup.events.push(eventId);
		await expect
			.poll(
				async () =>
					(await deliveriesOf(api, hookId)).filter((row) => row.eventType === "calendar.event.created").length,
			)
			.toBe(1);
		const [row] = (await deliveriesOf(api, hookId)).filter((item) => item.eventType === "calendar.event.created");
		expect(JSON.parse(row!.payload)).toMatchObject({
			type: "calendar.event.created",
			data: { ref: { kind: "calendar:event", id: eventId }, event: { id: eventId, title } },
		});

		const username = (await ownerBooking(api)).username;
		const slug = uniqueToken("hook-book").toLowerCase();
		const type = await api.post("/api/booking", {
			data: {
				name: "Hook booking",
				slug,
				durationMinutes: 30,
				weekdays: [0, 1, 2, 3, 4, 5, 6],
				timeRanges: [{ startTime: "09:00", endTime: "17:00" }],
				timeZone: "UTC",
				enabled: true,
			},
		});
		expect(type.status(), await type.text()).toBe(200);
		cleanup.bookings.push(((await type.json()) as { event: { id: string } }).event.id);
		const page = `/api/public/booking/${slug}?username=${username}`;
		const { slots } = (await (await visitorApi.get(page)).json()) as { slots: { startsAt: string }[] };
		const booker = { name: "Hook Booker", email: "hook.booker@example.org", startsAt: slots[0]!.startsAt };
		const booked = await visitorApi.post(page, { data: booker });
		expect(booked.status(), await booked.text()).toBe(200);
		expect((await visitorApi.post(page, { data: booker })).status()).toBe(409);
		await expect
			.poll(
				async () =>
					(await deliveriesOf(api, hookId)).filter((row) => row.eventType === "booking.appointment.created").length,
			)
			.toBe(1);
		const appointment = (await deliveriesOf(api, hookId)).find(
			(item) => item.eventType === "booking.appointment.created",
		)!;
		expect(JSON.parse(appointment.payload).data).toMatchObject({
			ref: { kind: "booking:appointment" },
			appointment: { bookerEmail: "hook.booker@example.org", timeZone: "UTC" },
		});

		await setModuleState(api, { modules: { calendar: false } });
		const before = (await deliveriesOf(api, hookId)).length;
		expect(
			(
				await api.post("/api/calendar/events", {
					data: { title, startsAt: "2031-05-06T10:00:00Z", endsAt: "2031-05-06T11:00:00Z" },
				})
			).status(),
		).toBe(404);
		const retry = await api.post(`/api/webhooks/${hookId}/deliveries/${row!.id}/retry`);
		expect(retry.status(), await retry.text()).toBe(200);
		await expect
			.poll(async () => (await deliveriesOf(api, hookId)).find((item) => item.id === row!.id)?.error ?? "")
			.toContain("module_disabled");
		expect((await deliveriesOf(api, hookId)).length).toBe(before);
	} finally {
		await restoreModules(api);
		for (const id of cleanup.events) await api.delete(`/api/calendar/events/${id}`);
		for (const id of cleanup.bookings) await api.delete(`/api/booking/${id}`);
		await deleteWebhooks(api, cleanup.webhooks);
		await visitorApi.dispose();
		await api.dispose();
	}
});

test("JMAP answers the same session and methods with every module on and every module off", async () => {
	const api = await owner();
	const jmap = await visitor();
	const created: string[] = [];
	try {
		const mailboxId = await mailboxIdOf(api);
		const key = await api.post("/api/api-keys", {
			data: { name: "E2E jmap modules", mailboxIds: [mailboxId], scopes: ["jmap"] },
		});
		expect(key.status(), await key.text()).toBe(200);
		const { id, key: secret } = (await key.json()) as { id: string; key: string };
		created.push(id);
		const headers = { Authorization: `Bearer ${secret}` };
		const session = async () =>
			(await (await jmap.get("/jmap/session", { headers })).json()) as Record<string, unknown>;
		const call = async (methodCalls: unknown[]) =>
			(await (
				await jmap.post("/jmap/api", {
					headers,
					data: { using: ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"], methodCalls },
				})
			).json()) as {
				methodResponses: [string, Record<string, unknown>, string][];
			};
		const withModulesOn = await session();
		expect(Object.keys(withModulesOn.capabilities as object).sort()).toEqual([
			"urn:ietf:params:jmap:core",
			"urn:ietf:params:jmap:mail",
			"urn:ietf:params:jmap:submission",
		]);
		const accountId = Object.keys(withModulesOn.accounts as object)[0];
		const mailboxes = await call([["Mailbox/get", { accountId }, "m"]]);
		expect(mailboxes.methodResponses[0][0]).toBe("Mailbox/get");

		await setModuleState(api, { modules: { calendar: false, templates: false, import: false } });
		expect(await session()).toEqual(withModulesOn);
		const off = await call([
			["Mailbox/get", { accountId }, "m"],
			["Email/query", { accountId, limit: 5 }, "q"],
			["Calendar/get", { accountId }, "x"],
		]);
		expect(off.methodResponses.map(([name]) => name)).toEqual(["Mailbox/get", "Email/query", "error"]);
		expect(off.methodResponses[0][1]).toEqual(mailboxes.methodResponses[0][1]);
		expect(off.methodResponses[2][1]).toEqual({ type: "unknownMethod" });
	} finally {
		await restoreModules(api);
		await deleteKeys(api, { api: created });
		await jmap.dispose();
		await api.dispose();
	}
});

// Fails this file when one of its tests left a module off or a user restricted.
test.afterAll(async () => {
	await expectEveryModuleOn();
});
