import { importMessagesToMailbox } from "@/lib/import/service";
import { parseImportDestination } from "@/lib/import/destination";
import type { HostImportResult, HostImportMessage } from "@/lib/modules/host-types";
import { decodeHostImportMessage } from "./module-import-utils";

/**
 * The module import path: the same parse, threading, attachment and contact writes as every import,
 * for a mailbox the caller names. The caller has already decided the owner and the destination; this
 * only refuses a destination that is not one.
 */
export async function importModuleMessages(
	env: CloudflareEnv,
	request: { userId: string; mailboxId: string; destination: string; messages: HostImportMessage[] },
): Promise<HostImportResult> {
	const result = await importMessagesToMailbox(env, {
		userId: request.userId,
		mailboxId: request.mailboxId,
		destination: parseImportDestination(request.destination),
		messages: request.messages.map(decodeHostImportMessage),
	});
	// `skipped` of the write path counts both duplicates and failures; the host reports them apart.
	const failed = result.errors.length;
	return { imported: result.imported, skipped: Math.max(result.skipped - failed, 0), failed, errors: result.errors };
}
