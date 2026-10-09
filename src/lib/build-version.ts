/** Replaced at build time by both Vite and Next, not read from runtime bindings. */
export const BUILD_VERSION = process.env.NEXT_PUBLIC_KITE_BUILD_VERSION ?? "development";
const commit = process.env.NEXT_PUBLIC_KITE_BUILD_COMMIT ?? "unknown";

export const BUILD_VERSION_LABEL = `${BUILD_VERSION} (${commit})`;
