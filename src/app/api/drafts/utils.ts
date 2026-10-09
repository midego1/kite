import { NextResponse } from "next/server";
import { getAuthorizedSenderAddress } from "@/lib/email/sender";
import { RequestBodyTooLargeError } from "@/lib/http/errors";
import { readJsonBody } from "@/lib/http/request";
import type { DraftPayload } from "./types";

export async function getDraftSender(
	env: CloudflareEnv,
	userId: string,
	input: DraftPayload,
): Promise<{ fromAddr: string; mailboxId: string } | { error: string }> {
	try {
		return await getAuthorizedSenderAddress(env, {
			userId,
			from: input.from ?? "",
			mailboxId: input.mailboxId,
		});
	} catch (error) {
		return { error: error instanceof Error ? error.message : "Mailbox is not authorized" };
	}
}

export function userOwnsDraft(draft: { userId: string; status: string } | undefined, userId: string): boolean {
	return !!draft && draft.userId === userId && draft.status === "draft";
}

export async function readDraftPayload(request: Request) {
	try {
		return { input: await readJsonBody<DraftPayload>(request, 1024 * 1024), response: null } as const;
	} catch (error) {
		const status = error instanceof RequestBodyTooLargeError ? 413 : 400;
		return { input: null, response: NextResponse.json({ error: "Invalid draft request" }, { status }) } as const;
	}
}
