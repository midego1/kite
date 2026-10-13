// Pure helpers for scripts/review/coderabbit-comments.mjs, split out so the unit tests
// can cover the selection without talking to the GitHub API.

/**
 * Selects the CodeRabbit comments an adopt run still has to decide about: the reviewer's
 * top-level findings that still anchor to the pull request's current head and whose thread
 * has no reply from the adopt workflow yet. Replies inside a thread (a human, the workflow
 * bot, CodeRabbit's own follow-up) never start work, and a comment that was already handled
 * is either outdated (position null once a newer commit moved its anchor) or answered by the
 * bot, so no run repeats a decision.
 */
export function selectActionableComments(comments, options = {}) {
	const reviewerLogin = options.reviewerLogin ?? "coderabbitai[bot]";
	const botLogin = options.botLogin ?? "github-actions[bot]";
	const answered = new Set(
		comments
			.filter((comment) => comment.in_reply_to_id != null && comment.user?.login === botLogin)
			.map((comment) => comment.in_reply_to_id),
	);
	return comments
		.filter((comment) => comment.user?.login === reviewerLogin)
		.filter((comment) => comment.in_reply_to_id == null)
		.filter((comment) => comment.position != null)
		.filter((comment) => !answered.has(comment.id))
		.map((comment) => ({
			id: comment.id,
			path: comment.path,
			line: comment.line ?? comment.original_line ?? null,
			body: comment.body,
		}));
}
