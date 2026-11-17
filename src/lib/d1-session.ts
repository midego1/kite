import { runWithD1Session } from "./d1-session-context";
import { openD1Session, withD1BookmarkCookie, withD1Session } from "./d1-session-utils";

/**
 * Runs a fetch on a D1 session anchored at the browser's bookmark cookie, so D1 can serve its reads from read
 * replicas, and stores the session's newest bookmark on the response. `handle` receives the env with `DB` swapped,
 * and everything it calls sees the same session through `getEnv()`. Requests that take no session (see
 * `d1SessionMode`) run on the raw env and get no cookie.
 */
export async function fetchWithD1Session<E extends CloudflareEnv>(
	request: Request,
	env: E,
	handle: (request: Request, env: E) => Promise<Response>,
): Promise<Response> {
	const database = openD1Session(env, request);
	if (!database) return handle(request, env);
	const response = await runWithD1Session(database, () => handle(request, withD1Session(env, database)));
	return withD1BookmarkCookie(request, response, database);
}
