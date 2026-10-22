import { BUILD_TIME, BUILD_VERSION_LABEL } from "@/lib/build-version";

/**
 * Identifies the code this server runs, so an open tab can notice that a newer
 * deployment is live. On Workers that is the version id of the deployment;
 * without the `CF_VERSION_METADATA` binding (Node/Docker, or a deploy whose own
 * config lacks it) it is the build identity baked in at build time. An empty
 * string means unknown, and the client then never reports an update.
 */
export function getDeploymentVersion(env: Pick<CloudflareEnv, "CF_VERSION_METADATA">): string {
	const id = env.CF_VERSION_METADATA?.id;
	if (id) return id;
	return BUILD_TIME ? `${BUILD_VERSION_LABEL} ${BUILD_TIME}` : "";
}
