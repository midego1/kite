### Changed

- The Activity listing of MCP tool calls and the pruning of old MCP tool call audit rows are faster on a large audit log: migration 0087 adds the index `audit_logs_action_created_idx` on `audit_logs (action, created_at)`. Apply it from the database update banner or the [Admin overview](/admin); until then everything works as before.
