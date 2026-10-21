import type { MxCheckState } from "./types";

/**
 * Whether the existing-MX check still holds back "Create account": while it runs, when it
 * could not be read, or when other MX records exist and replacing them was not confirmed.
 * A domain added with DNS skipped never has its MX records checked or changed.
 */
export function mxCheckBlocksSubmit(state: MxCheckState): boolean {
	if (state.skipDns) return false;
	if (state.checking || state.recordsExist === null) return true;
	return state.recordsExist && !state.replaceRecords;
}
