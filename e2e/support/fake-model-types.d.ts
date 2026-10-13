export type FakeRequestKind = "triage" | "repair" | "draft" | "other";

export type FakeToolCall = { name: string; arguments?: unknown };

export type FakeModelReply = {
	content?: string;
	/** Tool calls the model makes instead of (or before) answering; the request's finish reason becomes `tool_calls`. */
	toolCalls?: FakeToolCall[];
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

/** One chat step a spec scripts: tool calls to make, or the text to answer with. */
export type FakeChatStep = FakeModelReply;

export type FakeRecordedTool = { name: string; description: string | null; parameters: unknown };

export type FakeRecordedRequest = {
	id: number;
	receivedAt: string;
	method: string;
	path: string;
	kind: FakeRequestKind | null;
	scenario: string | null;
	emailId: string | null;
	/** Whether the request asked for a streamed (`stream: true`) answer, as the assistant chat does. */
	stream: boolean;
	/** The functions the request offered, in order; empty when it offered none. */
	tools: FakeRecordedTool[];
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
	/** Replies for the next chat requests that are not triage or draft requests (the assistant chat), in order. */
	scriptChat: (...steps: FakeChatStep[]) => void;
	/** Answers every reply that is waiting out its `slow` delay now; later slow requests wait again. */
	releaseDelayed: () => void;
	close: () => Promise<void>;
};
