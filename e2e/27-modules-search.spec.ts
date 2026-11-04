import { expect, test, type APIRequestContext } from "@playwright/test";
import { uniqueToken } from "./support/helpers";
import { restoreModules, setModuleState } from "./support/modules";
import { createEvent, createMember, deleteKeys, owner, searchSections, visitor } from "./support/module-spec";

test("GET /api/search returns the viewer's own events with refs and links, and nothing for anyone else", async () => {
	const api = await owner();
	const member = await createMember(api);
	const events: { api: APIRequestContext; id: string }[] = [];
	try {
		const ownerWord = uniqueToken("ownerword");
		const memberWord = uniqueToken("memberword");
		const ownerEvent = await createEvent(api, `Review ${ownerWord}`, { location: "Room 4" });
		events.push({ api, id: ownerEvent });
		events.push({ api: member.api, id: await createEvent(member.api, `Review ${memberWord}`) });

		const [section, ...others] = await searchSections(api, ownerWord, "&limit=5");
		expect(others).toEqual([]);
		expect(section).toMatchObject({ id: "events", label: "Events" });
		expect(section!.items).toHaveLength(1);
		const [item] = section!.items;
		expect(item).toMatchObject({ ref: { kind: "calendar:event", id: ownerEvent }, label: `Review ${ownerWord}` });
		expect(item!.sublabel).toContain("Room 4");
		expect(item!.href).toBe(`/calendar?date=2031-05-05&event=${ownerEvent}`);

		expect(await searchSections(api, memberWord)).toEqual([]);
		expect(await searchSections(member.api, ownerWord)).toEqual([]);
		expect((await searchSections(member.api, memberWord))[0]!.items).toHaveLength(1);
		expect(await searchSections(api, "from:someone has:attachment")).toEqual([]);
		expect(await searchSections(api, "")).toEqual([]);
	} finally {
		for (const { api: client, id } of events) await client.delete(`/api/calendar/events/${id}`);
		await member.api.dispose();
		await api.dispose();
	}
});

test("event search follows a rename and a delete, and covers description, location and guests", async () => {
	const api = await owner();
	let id = "";
	try {
		const alpha = uniqueToken("alphaword");
		const beta = uniqueToken("betaword");
		const extra = uniqueToken("extraword");
		const guest = uniqueToken("guestword");
		const fields = { description: `notes ${extra}`, location: `${extra}hall`, attendees: [`${guest}@example.org`] };
		id = await createEvent(api, alpha, fields);
		expect((await searchSections(api, alpha))[0]?.items.map((entry) => entry.ref.id)).toEqual([id]);
		expect((await searchSections(api, extra))[0]?.items.map((entry) => entry.ref.id)).toEqual([id]);
		expect((await searchSections(api, `${extra}hall`))[0]?.items.map((entry) => entry.ref.id)).toEqual([id]);

		expect((await searchSections(api, guest))[0]?.items.map((entry) => entry.ref.id)).toEqual([id]);

		const renamed = await api.patch(`/api/calendar/events/${id}`, {
			data: { title: beta, startsAt: "2031-05-05T10:00:00Z", endsAt: "2031-05-05T11:00:00Z", ...fields },
		});
		expect(renamed.status(), await renamed.text()).toBeLessThan(300);
		expect(await searchSections(api, alpha)).toEqual([]);
		expect((await searchSections(api, beta))[0]?.items.map((entry) => entry.ref.id)).toEqual([id]);

		expect((await api.delete(`/api/calendar/events/${id}`)).status()).toBeLessThan(300);
		id = "";
		expect(await searchSections(api, alpha)).toEqual([]);
		expect(await searchSections(api, beta)).toEqual([]);
	} finally {
		if (id) await api.delete(`/api/calendar/events/${id}`);
		await api.dispose();
	}
});

test("search needs a session: signed-out and key-only requests answer 401", async () => {
	const api = await owner();
	const anonymous = await visitor();
	const keyOnly = await visitor();
	const created: string[] = [];
	try {
		expect((await anonymous.get("/api/search?q=anything")).status()).toBe(401);
		const key = await api.post("/api/api-keys", {
			data: { name: "E2E search key", mailboxIds: [], scopes: ["calendar:read"] },
		});
		expect(key.status(), await key.text()).toBe(200);
		const { id, key: secret } = (await key.json()) as { id: string; key: string };
		created.push(id);
		const response = await keyOnly.get("/api/search?q=anything", { headers: { Authorization: `Bearer ${secret}` } });
		expect(response.status()).toBe(401);
	} finally {
		await deleteKeys(api, { api: created });
		await keyOnly.dispose();
		await anonymous.dispose();
		await api.dispose();
	}
});

test("with Calendar off or the user restricted, search has no Events section and it returns when Calendar is back", async () => {
	const api = await owner();
	const member = await createMember(api);
	let id = "";
	try {
		const word = uniqueToken("offword");
		id = await createEvent(api, word);
		expect((await searchSections(api, word))[0]?.id).toBe("events");

		await setModuleState(api, { modules: { calendar: false } });
		expect(await searchSections(api, word)).toEqual([]);
		await setModuleState(api, { modules: { calendar: true } });
		expect((await searchSections(api, word))[0]?.id).toBe("events");

		const memberWord = uniqueToken("memberoff");
		const memberEvent = await createEvent(member.api, memberWord);
		await setModuleState(api, { access: [{ userId: member.id, moduleId: "calendar", allowed: false }] });
		expect(await searchSections(member.api, memberWord)).toEqual([]);
		await setModuleState(api, { access: [{ userId: member.id, moduleId: "calendar", allowed: true }] });
		expect((await searchSections(member.api, memberWord))[0]?.id).toBe("events");
		await member.api.delete(`/api/calendar/events/${memberEvent}`);
	} finally {
		await restoreModules(api, [member.id]);
		if (id) await api.delete(`/api/calendar/events/${id}`);
		await member.api.dispose();
		await api.dispose();
	}
});

test("the mail search dropdown lists Events, opens the chosen event and leaves Enter to the mail search", async ({
	page,
}) => {
	const api = await owner();
	let id = "";
	try {
		const word = uniqueToken("dropword");
		id = await createEvent(api, `Planning ${word}`, { location: "Harbour" });
		await page.goto("/inbox");
		const field = page.getByRole("textbox", { name: /Search mail/ });
		await field.fill(word);
		const dropdown = page.getByTestId("search-dropdown");
		const events = dropdown.locator('[data-search-section="events"]');
		await expect(events.getByText("Events", { exact: true })).toBeVisible();
		await expect(events.getByRole("option", { name: new RegExp(`Planning ${word}`) })).toBeVisible();

		// Enter with nothing highlighted keeps the mail search: no navigation, the list is filtered.
		await field.press("Enter");
		await expect(page).toHaveURL(/\/inbox/);
		await expect(page.getByRole("main").getByText("No messages match these filters")).toBeVisible();

		await events.getByRole("option", { name: new RegExp(`Planning ${word}`) }).click();
		await expect(page).toHaveURL(/\/calendar/);
		const editor = page.getByRole("dialog", { name: "Edit event" });
		await expect(editor.getByRole("textbox", { name: "Event name" })).toHaveValue(`Planning ${word}`);
		await expect(page.getByRole("heading", { level: 1 }).or(page.getByText("May 2031")).first()).toBeVisible();
	} finally {
		if (id) await api.delete(`/api/calendar/events/${id}`);
		await api.dispose();
	}
});

test("a recurring event's search result and link open the editor, on its day and on a later one", async ({ page }) => {
	const api = await owner();
	let id = "";
	try {
		const word = uniqueToken("weeklyword");
		id = await createEvent(api, `Standup ${word}`, { repeat: "weekly" });
		await page.goto("/inbox");
		const field = page.getByRole("textbox", { name: /Search mail/ });
		await field.fill(word);
		const option = page.getByTestId("search-dropdown").getByRole("option", { name: new RegExp(`Standup ${word}`) });
		await expect(option).toBeVisible();
		await option.click();
		await expect(page).toHaveURL(/\/calendar/);
		const editor = page.getByRole("dialog", { name: "Edit event" });
		await expect(editor.getByRole("textbox", { name: "Event name" })).toHaveValue(`Standup ${word}`);
		await page.keyboard.press("Escape");

		// A ref link names the series id and the day of the occurrence to show.
		await page.goto(`/calendar?date=2031-05-12&event=${id}`);
		await expect(editor.getByRole("textbox", { name: "Event name" })).toHaveValue(`Standup ${word}`);
		await expect(editor.getByLabel("From date and time")).toHaveValue(/2031-05-12T/);
	} finally {
		if (id) await api.delete(`/api/calendar/events/${id}`);
		await api.dispose();
	}
});

test("a recurring series with an excluded start and no occurrence in the loaded range still opens its editor from a link", async ({
	page,
}) => {
	const api = await owner();
	const ids: string[] = [];
	const word = uniqueToken("cutword");
	const at = (day: string) => Date.parse(`2020-01-${day}T10:00:00Z`);
	// Weekly from Jan 6 (past), first occurrence moved out (excluded), then cut off before the later ones.
	const seriesCutAt = async (title: string, cutDay: string) => {
		const id = await createEvent(api, title, {
			repeat: "weekly",
			startsAt: "2020-01-06T10:00:00Z",
			endsAt: "2020-01-06T11:00:00Z",
		});
		ids.push(id);
		const moved = await api.patch(`/api/calendar/events/${id}@${at("06")}`, {
			data: {
				title: `Moved ${title}`,
				startsAt: "2020-01-07T10:00:00Z",
				endsAt: "2020-01-07T11:00:00Z",
				moveOccurrenceToPast: true,
			},
		});
		expect(moved.status(), await moved.text()).toBe(200);
		const cut = await api.delete(`/api/calendar/events/${id}@${at(cutDay)}`);
		expect(cut.status(), await cut.text()).toBe(200);
		return id;
	};
	try {
		const partial = await seriesCutAt(`Partial ${word}`, "20");
		const empty = await seriesCutAt(`Empty ${word}`, "13");
		const editor = page.getByRole("dialog", { name: "Edit event" });
		const name = editor.getByRole("textbox", { name: "Event name" });

		// The only surviving occurrence (Jan 13) is outside the range a 2031 link loads.
		await page.goto(`/calendar?date=2031-05-12&event=${partial}`);
		await expect(name).toHaveValue(`Partial ${word}`);
		await expect(editor.getByLabel("From date and time")).toHaveValue(/2020-01-0[56]T/);

		// No occurrence survives at all, with and without a date.
		await page.goto(`/calendar?event=${empty}`);
		await expect(name).toHaveValue(`Empty ${word}`);

		await page.goto("/inbox");
		await page.getByRole("textbox", { name: /Search mail/ }).fill(`Empty ${word}`);
		await page
			.getByTestId("search-dropdown")
			.getByRole("option", { name: new RegExp(`^Empty ${word}`) })
			.click();
		await expect(page).toHaveURL(/\/calendar/);
		await expect(name).toHaveValue(`Empty ${word}`);
	} finally {
		const moved = await api.get("/api/calendar/events?start=2020-01-01T00:00:00Z&end=2020-01-31T00:00:00Z");
		const rows = ((await moved.json()) as { events: { id: string; title: string }[] }).events;
		for (const row of rows) if (row.title.includes(word)) ids.push(row.id);
		for (const id of ids) await api.delete(`/api/calendar/events/${id}`);
		await api.dispose();
	}
});

test("the dropdown is keyboard driven and gone with Calendar off", async ({ page }) => {
	const api = await owner();
	let id = "";
	try {
		const word = uniqueToken("keyword");
		id = await createEvent(api, `Keys ${word}`);
		await page.goto("/inbox");
		const field = page.getByRole("textbox", { name: /Search mail/ });
		await field.fill(word);
		await expect(page.getByRole("option", { name: new RegExp(`Keys ${word}`) })).toBeVisible();
		await field.press("Escape");
		await expect(page.getByTestId("search-dropdown")).toHaveCount(0);
		await field.fill(`${word} `);
		await field.fill(word);
		await field.press("ArrowDown");
		await expect(page.getByRole("option", { name: new RegExp(`Keys ${word}`) })).toHaveAttribute(
			"aria-selected",
			"true",
		);
		await field.press("Enter");
		await expect(page).toHaveURL(/\/calendar/);
		await expect(
			page.getByRole("dialog", { name: "Edit event" }).getByRole("textbox", { name: "Event name" }),
		).toHaveValue(`Keys ${word}`);

		await setModuleState(api, { modules: { calendar: false } });
		await page.goto("/inbox");
		await page.getByRole("textbox", { name: /Search mail/ }).fill(word);
		await expect(page.getByText("No messages match these filters")).toBeVisible();
		await expect(page.getByTestId("search-dropdown")).toHaveCount(0);
	} finally {
		await restoreModules(api);
		if (id) await api.delete(`/api/calendar/events/${id}`);
		await api.dispose();
	}
});
