import { D1TestVectorStore } from "./d1-test-vector-store";
import { VectorizeStore } from "./vectorize-store";

/**
 * The vector store `indexer.ts` and `search.ts` use, implemented by `vectorize-store.ts` (Workers), the Node
 * self-hosted store (`server/runtime/sqlite-vector-store.ts`, arriving through `env.VECTORS`) and the dev/e2e test
 * store (`d1-test-vector-store.ts`, built lazily over `env.DB` when `SEMANTIC_TEST_STORE` is set; `wrangler dev` has
 * no local Vectorize emulation without remote access). `getVectorStore` tries, in order: the real binding, the Node
 * store, the test store.
 */
export interface VectorStore {
	upsert(items: { id: string; values: Float32Array; mailboxId: string }[]): Promise<void>;
	deleteByIds(ids: string[]): Promise<void>;
	/** Nearest chunks among the given mailboxes, best first, at most `options.topK` of them. */
	query(
		vector: Float32Array,
		options: { mailboxIds: string[]; topK: number },
	): Promise<{ id: string; score: number }[]>;
	/**
	 * Every vector id, a page at a time (cursor `0` starts; a null `cursor` in the result means done). Only the
	 * stores with a real backing table to enumerate (Node, dev/e2e) implement this; Vectorize's binding does not
	 * support listing, so "Clear stale vectors" is unavailable on Workers (`admin-actions.ts`).
	 */
	listIds?(cursor: number): Promise<{ ids: string[]; cursor: number | null }>;
}

/** No vector store is configured for this runtime (an install that has not set `VECTORIZE` up yet, or Node without `VECTORS`). */
export class VectorStoreUnavailableError extends Error {
	constructor() {
		super("No vector store is configured");
		this.name = "VectorStoreUnavailableError";
	}
}

type VectorStoreEnv = Pick<CloudflareEnv, "VECTORIZE" | "DB" | "SEMANTIC_TEST_STORE"> & { VECTORS?: VectorStore };

const testStores = new WeakMap<object, VectorStore>();

export function getVectorStore(env: VectorStoreEnv): VectorStore {
	if (env.VECTORIZE) return new VectorizeStore(env.VECTORIZE);
	if (env.VECTORS) return env.VECTORS;
	if (env.SEMANTIC_TEST_STORE === "1" && process.env.NODE_ENV !== "production") {
		let store = testStores.get(env.DB);
		if (!store) {
			store = new D1TestVectorStore(env.DB);
			testStores.set(env.DB, store);
		}
		return store;
	}
	throw new VectorStoreUnavailableError();
}
