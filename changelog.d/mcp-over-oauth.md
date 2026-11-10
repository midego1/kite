### Added

- AI apps such as Claude Desktop can now connect to Kite's MCP server by signing in instead of using a pasted API key: you approve each app in Kite and choose its permissions and mailboxes. It needs a database update from the Admin overview; see [Connecting an MCP app with OAuth](https://github.com/midego1/kite/blob/main/docs/email-assistant-and-mcp.md#connecting-an-mcp-app-with-oauth).
  ![The consent screen asking whether to allow an MCP app, with Read mail ticked and the mailboxes to share](/changelog/2026-11-10-mcp-oauth-consent-light.webp)
- [Settings → MCP apps](/settings/mcp-apps) lists the apps you connected, with their permissions and when they were last used, and **Revoke** ends an app's access at once.
  ![Settings → MCP apps with one connected app and its Revoke button](/changelog/2026-11-10-mcp-apps-settings-light.webp)
