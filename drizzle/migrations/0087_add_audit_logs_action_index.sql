-- The audit log listing filtered by action (`/api/audit-logs`, the MCP tool call view) and the MCP tool call
-- pruning both select one action in a created_at range or order; this lets them read just those rows instead of
-- walking `audit_logs_created_idx` through every other action.
CREATE INDEX `audit_logs_action_created_idx` ON `audit_logs` (`action`,`created_at`);
