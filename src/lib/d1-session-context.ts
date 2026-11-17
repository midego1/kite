import { AsyncLocalStorage } from "node:async_hooks";
import type { SessionDatabase } from "./d1-session-utils";

/**
 * The D1 session serving the current request. `getEnv()` reads bindings from `cloudflare:workers`, not from the env
 * `worker.ts` receives, so the session travels with the request: `worker.ts` runs the request inside
 * `runWithD1Session` and `getEnv()` swaps `DB` for it. Kept on `globalThis` so a module loaded twice (the dev
 * server's separate environments) still shares one store.
 */
const STORE = Symbol.for("kite.d1-session.store");
const holder = globalThis as typeof globalThis & { [STORE]?: AsyncLocalStorage<SessionDatabase> };
const storage = (holder[STORE] ??= new AsyncLocalStorage<SessionDatabase>());

export function runWithD1Session<T>(database: SessionDatabase | null | undefined, run: () => T): T {
	return database ? storage.run(database, run) : run();
}

export function currentD1Session(): SessionDatabase | undefined {
	return storage.getStore();
}
