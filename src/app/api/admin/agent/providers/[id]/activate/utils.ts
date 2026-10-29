import { auditAgentProvider } from "@/lib/agent/provider-admin";
import { activateAgentProvider } from "@/lib/agent/provider-connections";
import { adminAgentResponse, authorizeAgentAdmin } from "../../../utils";
import { providerErrorResponse } from "../utils";

type Params = { params: Promise<{ id: string }> };

/** Switches every AI feature to this saved provider at once; nothing is retyped. */
export async function POST(request: Request, { params }: Params) {
	const access = await authorizeAgentAdmin(request, true);
	if (access.error) return access.error;
	const { id } = await params;
	try {
		const switched = await activateAgentProvider(access.env, id);
		if (switched)
			await auditAgentProvider(access.env, access.user.id, "agent.provider_switched", { providerId: id, ...switched });
	} catch (error) {
		const response = providerErrorResponse(error);
		if (response) return response;
		throw error;
	}
	return adminAgentResponse(access.env);
}
