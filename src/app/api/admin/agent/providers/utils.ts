import { z } from "zod";
import { auditAgentProvider, prepareAgentProviderValues, providerSchema } from "@/lib/agent/provider-admin";
import { AgentProvidersPendingError, createAgentProvider, listAgentProviders } from "@/lib/agent/provider-connections";
import { adminAgentResponse, authorizeAgentAdmin } from "../utils";

const createSchema = providerSchema.extend({ activate: z.boolean().optional() });

export function providersPendingResponse() {
	return Response.json({ error: new AgentProvidersPendingError().message, code: "MIGRATION_PENDING" }, { status: 409 });
}

/** Saves another provider; it is used at once only when `activate` is set or nothing else is saved. */
export async function POST(request: Request) {
	const access = await authorizeAgentAdmin(request, true);
	if (access.error) return access.error;
	const parsed = createSchema.safeParse(await request.json().catch(() => null));
	if (!parsed.success) return Response.json({ error: "Invalid provider settings" }, { status: 400 });
	if (!(await listAgentProviders(access.env)).ready) return providersPendingResponse();
	const { activate, ...input } = parsed.data;
	const prepared = await prepareAgentProviderValues(access.env, input, "new");
	if (prepared.error !== undefined) return Response.json({ error: prepared.error }, { status: 400 });
	const id = await createAgentProvider(access.env, prepared.values, { activate });
	const saved = (await listAgentProviders(access.env)).providers.find((provider) => provider.id === id);
	await auditAgentProvider(access.env, access.user.id, "agent.provider_added", {
		providerId: id,
		name: saved?.name ?? "",
	});
	return adminAgentResponse(access.env, { status: 201 });
}
