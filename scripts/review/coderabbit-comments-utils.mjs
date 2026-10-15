// Pure helpers for scripts/review/coderabbit-comments.mjs, split out so the unit tests
// can cover the selection without talking to the GitHub API.

/** The AI reviewers whose comments the adopt workflow handles, by GitHub login. */
export const REVIEWERS = {
	"coderabbitai[bot]": "CodeRabbit",
	"greptile-apps[bot]": "Greptile",
};

export const ADOPT_BOT_LOGIN = "github-actions[bot]";

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
