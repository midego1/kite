import { expect, test } from "@playwright/test";
import { STORAGE_STATE, SUPPORT_ADDRESS } from "./support/constants";
import { apiContext, uniqueToken } from "./support/helpers";

// The dev server once answered every multipart POST over 1 MB with 413 before the route handler ran.
const TWO_MB = 2 * 1024 * 1024;

test("a draft accepts a multipart attachment upload larger than 1 MB", async () => {
	const api = await apiContext(STORAGE_STATE);
	const { mailboxes } = (await (await api.get("/api/mailboxes")).json()) as {
		mailboxes: { id: string; localPart: string; hostname: string }[];
	};
	const mailbox = mailboxes.find((item) => `${item.localPart}@${item.hostname}` === SUPPORT_ADDRESS);
	expect(mailbox, SUPPORT_ADDRESS).toBeDefined();
	const created = await api.post("/api/drafts", {
		data: {
			mailboxId: mailbox!.id,
			from: SUPPORT_ADDRESS,
			to: "someone@outside.test",
			subject: `Large attachment ${uniqueToken()}`,
			html: "<p>See attached.</p>",
		},
	});
	expect(created.ok(), await created.text()).toBe(true);
	const { draft } = (await created.json()) as { draft: { id: string } };

	try {
		const upload = await api.post(`/api/drafts/${draft.id}/attachments`, {
			multipart: {
				attachments: { name: "scan.bin", mimeType: "application/octet-stream", buffer: Buffer.alloc(TWO_MB, 7) },
			},
		});
		expect(upload.status(), await upload.text()).toBe(200);
		const detail = (await (await api.get(`/api/drafts/${draft.id}`)).json()) as {
			draft: { attachments: { filename: string; size: number }[] };
		};
		expect(detail.draft.attachments).toEqual([expect.objectContaining({ filename: "scan.bin", size: TWO_MB })]);
	} finally {
		await api.delete(`/api/drafts/${draft.id}`);
		await api.dispose();
	}
});
