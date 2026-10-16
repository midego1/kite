// Pure helpers for scripts/review/coderabbit-comments.mjs, split out so the unit tests
// can cover the selection without talking to the GitHub API.

/** The AI reviewers whose comments the adopt workflow handles, by GitHub login. */
export const REVIEWERS = {
	"coderabbitai[bot]": "CodeRabbit",
	"greptile-apps[bot]": "Greptile",
};

export const ADOPT_BOT_LOGIN = "github-actions[bot]";

/**
 * The npm scripts the adopt workflow runs on Droid's commits before they may be pushed: the
 * CI gate except the build and e2e, which Droid runs itself for the specs a fix touches.
 */
export const ADOPT_GATE_CHECKS = ["check", "test:coverage", "quality:check", "docs:check"];

const ADDRESSES_LINE = new RegExp(`Addresses (?:${Object.values(REVIEWERS).join("|")}) review comment (\\d+)`, "g");

/** The review comment ids that commit messages adopt, from their `Addresses ...` lines. */
export function adoptedCommentIds(messages) {
	const ids = new Set();
	for (const message of messages) {
		for (const match of message.matchAll(ADDRESSES_LINE)) ids.add(Number(match[1]));
	}
	return [...ids].sort((a, b) => a - b);
}

/**
 * The replies once the workflow's gate has dropped the adoptions: every adopted comment
 * becomes `Valid, not adopted`, the prefix the reviewer scoreboard counts as a finding that
 * held up, and keeps an answer Droid already wrote for it.
 */
export function rejectedAdoptionReplies(adoptedIds, failedChecks, replies = []) {
	const checks = failedChecks.map((check) => `\`npm run ${check}\``).join(", ");
	const body = `Valid, not adopted: the fix failed ${checks} in the workflow's checks, which pass without it, so it was not pushed.`;
	return answerAdoptions(adoptedIds, body, replies);
}

/** Answers each adopted comment with `body`, keeping an answer that already exists for it. */
export function answerAdoptions(adoptedIds, body, replies = []) {
	const answered = new Set(replies.map((reply) => reply.commentId));
	return [...replies, ...adoptedIds.filter((id) => !answered.has(id)).map((commentId) => ({ commentId, body }))];
}

/**
 * GitHub refuses a push that changes a workflow file unless the token has the `workflows`
 * permission, which the adopt workflow deliberately lacks: an AI-written change to CI would
 * otherwise run with the repository's secrets.
 */
export function touchesWorkflowFiles(files) {
	return files.some((file) => file.startsWith(".github/workflows/"));
}

export const WORKFLOW_CHANGE_REPLY =
	"Valid, not adopted: the fix changes a GitHub Actions workflow (or builds on such a change), which the adopt workflow may not push, so a person has to apply it.";

/**
 * Selects the reviewer comments an adopt run still has to decide about: each reviewer's
 * top-level findings that still anchor to the pull request's current head and whose thread
 * has no reply from the adopt workflow yet. Replies inside a thread (a human, the workflow
 * bot, a reviewer's own follow-up) never start work, and a comment that was already handled
 * is either outdated (position null once a newer commit moved its anchor) or answered by the
 * bot, so no run repeats a decision.
 */
export function selectActionableComments(comments, options = {}) {
	const reviewers = options.reviewers ?? REVIEWERS;
	const botLogin = options.botLogin ?? ADOPT_BOT_LOGIN;
	const answered = new Set(
		comments
			.filter((comment) => comment.in_reply_to_id != null && comment.user?.login === botLogin)
			.map((comment) => comment.in_reply_to_id),
	);
	return comments
		.filter((comment) => Object.hasOwn(reviewers, comment.user?.login ?? ""))
		.filter((comment) => comment.in_reply_to_id == null)
		.filter((comment) => comment.position != null)
		.filter((comment) => !answered.has(comment.id))
		.map((comment) => ({
			id: comment.id,
			reviewer: reviewers[comment.user.login],
			path: comment.path,
			line: comment.line ?? comment.original_line ?? null,
			body: comment.body,
		}));
}
