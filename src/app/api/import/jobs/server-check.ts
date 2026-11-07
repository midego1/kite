import { importServerRefusal } from "@/lib/import/imap";
import { importSignInGuard, SignInLimitError, signInLimitResponse } from "@/lib/import/sign-in-limit";

/**
 * On Node, the server's name resolved before the job is saved, so a saved job never keeps a name that points at a
 * private address. Runs after the mailbox checks, and a refused lookup counts against the import sign-in limit, so
 * saving jobs cannot map the network's names without limit. The error answer, or null.
 */
export async function resolveServer(
	env: CloudflareEnv,
	userId: string,
	server: { host: string; port: number },
): Promise<Response | null> {
	try {
		const refused = await importServerRefusal(env, server, importSignInGuard(env, userId));
		return refused ? Response.json({ error: refused }, { status: 400 }) : null;
	} catch (error) {
		if (error instanceof SignInLimitError) return signInLimitResponse(error);
		throw error;
	}
}
