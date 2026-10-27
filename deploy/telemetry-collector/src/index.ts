import { handleRequest, runDailyTasks, type CollectorEnv } from "./collector";

/** The Worker entrypoint. Export nothing else here: workerd treats every named export as an entrypoint. */
export default {
	fetch: (request: Request, env: CollectorEnv): Promise<Response> => handleRequest(request, env),
	async scheduled(controller: ScheduledController, env: CollectorEnv, ctx: ExecutionContext): Promise<void> {
		ctx.waitUntil(runDailyTasks(env, controller.scheduledTime));
	},
} satisfies ExportedHandler<CollectorEnv>;
