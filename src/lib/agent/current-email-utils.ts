// Only the ID: the subject is email content and must not reach the model as an instruction.
function agentCurrentEmailContext(emailId: string) {
	return `The user now has email ${emailId} open, which may not be the email discussed earlier. "This email", "this thread" or "this message" means email ${emailId}; read it with get_email using emailId ${emailId} before answering about it or drafting a reply. Use get_thread when thread context is needed.`;
}

// Added to the latest turn rather than the system prompt so it outweighs emails named earlier in the history; never stored.
export function withCurrentEmailContext(text: string, emailId: string | null) {
	return emailId ? `${text}\n\n(${agentCurrentEmailContext(emailId)})` : text;
}
