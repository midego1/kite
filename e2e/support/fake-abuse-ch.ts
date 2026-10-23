import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { FAKE_ABUSE_CH_PORT } from "./constants";

/** Invented keys: the fake accepts the first, refuses the second and fails for the third as if abuse.ch were down. */
export const FAKE_ABUSE_CH_KEYS = {
	works: "e2e-fake-abuse-ch-key-works-0001",
	rejected: "e2e-fake-abuse-ch-key-rejected-0002",
	unreachable: "e2e-fake-abuse-ch-key-unreachable-0003",
} as const;

export type FakeAbuseCh = {
	/** The Auth-Key header of every request, in order. */
	keys: string[];
	close(): Promise<void>;
};

function answer(request: IncomingMessage, response: ServerResponse, keys: string[]) {
	const key = String(request.headers["auth-key"] ?? "");
	keys.push(key);
	const threatfox = (request.url ?? "").startsWith("/api/v1/");
	if (key === FAKE_ABUSE_CH_KEYS.unreachable) {
		response.writeHead(503).end();
		return;
	}
	if (key !== FAKE_ABUSE_CH_KEYS.works) {
		response.writeHead(threatfox ? 200 : 401, { "Content-Type": "application/json" });
		response.end(JSON.stringify({ query_status: "unknown_auth_key" }));
		return;
	}
	response.writeHead(200, { "Content-Type": "application/json" });
	response.end(JSON.stringify(threatfox ? { query_status: "no_result" } : { query_status: "no_results" }));
}

/** Stands in for URLhaus and ThreatFox on the port the dev server's ABUSE_CH_TEST_ORIGIN names. */
export async function startFakeAbuseCh(): Promise<FakeAbuseCh> {
	const keys: string[] = [];
	const server = createServer((request, response) => {
		request.resume();
		request.on("end", () => answer(request, response, keys));
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(FAKE_ABUSE_CH_PORT, "127.0.0.1", () => resolve());
	});
	return {
		keys,
		close: () => new Promise<void>((resolve) => server.close(() => resolve())),
	};
}
