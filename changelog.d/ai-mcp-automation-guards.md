### Security

- The assistant's `get_thread`, automatic reply drafts and conversation summaries no longer read Spam, Trash, mail the Screener holds or other users' drafts from a conversation, so text an unapproved sender wrote cannot steer them (upstream Mailflare #225).
- JMAP `EmailSubmission/set` refuses to send a draft the AI assistant wrote until it was reviewed and confirmed in Kite, as the composer already did (upstream Mailflare #225).
- In assistant chat, changing or deleting calendar events is now a proposal you approve under the answer, listing each event and what would change; nothing changes before you click (upstream Mailflare #225).
- The send review of an AI draft says the assistant wrote it and warns about recipients you have never written to and have not saved as contacts (upstream Mailflare #225).
- The MCP server tells clients that mail and calendar content is untrusted third-party text, marks every result with `contentTrust`, labels read-only and destructive tools, and records each tool call (tool, key and outcome, never content) in the audit log, kept for 90 days and listed by `GET /api/audit-logs?action=mcp.tool_call` (upstream Mailflare #225).
