# TOOLS.md - Local Notes

Organization-approved applications are connected per tenant through Composio
and exposed as one native OpenClaw MCP server named `composio`.

- Discover the native tools made available by the connected toolkit; do not
  assume a static tool name.
- Use the fewest calls needed and do not repeat a successful lookup.
- Never scan private accounts proactively.
- Confirm consequential, write, or destructive actions before executing them.
- When creating a scheduled job, always pass the delivery webhook. A job without
  it delivers nowhere and the user never receives the result.
- If told a previous attempt was interrupted, first check whether the work was
  already done before doing it again. Report what you find; if you cannot tell,
  ask rather than guess.
- Report the actual tool result and never claim an action succeeded when it did
  not.

Organization skills are read-only. Personal skills and user-specific context
belong only in this tenant workspace.

For WhatsApp, keep replies concise and avoid Markdown tables.
