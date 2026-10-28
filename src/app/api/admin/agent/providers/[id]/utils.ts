import { auditAgentProvider, prepareAgentProviderValues, providerSchema } from "@/lib/agent/provider-admin";
import {
	ActiveAgentProviderError,
	AgentProviderNotFoundError,
	AgentProvidersPendingError,
	deleteAgentProvider,
	updateAgentProvider,
} from "@/lib/agent/provider-connections";
import { adminAgentResponse, authorizeAgentAdmin } from "../../utils";
import { providersPendingResponse } from "../utils";

type Params = { params: Promise<{ id: string }> };

/** The answer for a provider error, or null when `error` is not one; anything else is rethrown by the caller. */
export function providerErrorResponse(error: unknown): Response | null {
	if (error instanceof AgentProvidersPendingError) return providersPendingResponse();
	if (error instanceof AgentProviderNotFoundError) return Response.json({ error: error.message }, { status: 404 });
	if (error instanceof ActiveAgentProviderError)
		return Response.json({ error: error.message, code: "ACTIVE_PROVIDER" }, { status: 409 });
	return null;
}

/** Edits a saved provider; a blank key keeps its stored key while the endpoint stays the same. */
export async function PUT(request: Request, { params }: Params) {
	const access = await authorizeAgentAdmin(request, true);
	if (access.error) return access.error;
	const { id } = await params;
	const parsed = providerSchema.safeParse(await request.json().catch(() => null));
	if (!parsed.success) return Response.json({ error: "Invalid provider settings" }, { status: 400 });
	try {
		const prepared = await prepareAgentProviderValues(access.env, parsed.data, { id });
		if (prepared.error !== undefined) return Response.json({ error: prepared.error }, { status: 400 });
		await updateAgentProvider(access.env, id, prepared.values);
	} catch (error) {
		const response = providerErrorResponse(error);
		if (response) return response;
		throw error;
	}
	return adminAgentResponse(access.env);
}

/** Deletes a saved provider and its key; the provider in use is refused with 409 `ACTIVE_PROVIDER`. */
export async function DELETE(request: Request, { params }: Params) {
	const access = await authorizeAgentAdmin(request, true);
	if (access.error) return access.error;
	const { id } = await params;
	try {
		const { name } = await deleteAgentProvider(access.env, id);
		await auditAgentProvider(access.env, access.user.id, "agent.provider_deleted", { providerId: id, name });
	} catch (error) {
		const response = providerErrorResponse(error);
		if (response) return response;
		throw error;
	}
	return adminAgentResponse(access.env);
}
