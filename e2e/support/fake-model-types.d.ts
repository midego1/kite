export type FakeRequestKind = "triage" | "repair" | "draft" | "other";

export type FakeModelReply = {
	content?: string;
	finishReason?: "stop" | "length";
	/** Answer with this HTTP status and an OpenAI-style error body instead of a completion. */
	status?: number;
	delayMs?: number;
};

export type FakeScenarioContext = {
	/** 1 for the first request of this kind for the same `<<<EMAIL id=…>>>`, then 2, 3, … */
	callNumber: number;
	slowMs: number;
};

export type FakeScenario = {
	triage: (context: FakeScenarioContext) => FakeModelReply;
	draft?: (context: FakeScenarioContext) => FakeModelReply;
	/** Repair requests get the scenario's triage reply too; otherwise they get benign valid JSON. */
	repairsToo?: boolean;
};

export type FakeRecordedRequest = {
	id: number;
	receivedAt: string;
	method: string;
	path: string;
	kind: FakeRequestKind | null;
	scenario: string | null;
	emailId: string | null;
	body: unknown;
};

export type FakeModelOptions = {
	port?: number;
	/** Delay for the `slow` scenario; 20 s by default. */
	slowMs?: number;
};

export type FakeModel = {
	url: string;
	port: number;
	requests: () => FakeRecordedRequest[];
	clearRequests: () => void;
	setDefaultScenario: (name: string) => void;
	resetDefaultScenario: () => void;
	/** Scenarios used, in order, for the next chat requests ahead of any marker or default. */
	enqueueScenario: (...names: string[]) => void;
	/** Answers every reply that is waiting out its `slow` delay now; later slow requests wait again. */
	releaseDelayed: () => void;
	close: () => Promise<void>;
};
