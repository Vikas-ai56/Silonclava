# Rocky Composio connector sidecar

This is the connector-only portion of iRock adapted for Rocky. It is not the
iRock desktop app or CLI and contains no model, agent, session, desktop login,
workspace, or provider-tool execution runtime.

Source reference:

- Repository: `https://github.com/buglerock-capital/irock-desktop`
- Commit: `eb071099c5ab98a65277f53e5c654cc6b64b45f8`
- Original connector package:
  `apps/backend/src/rocky_backend/features/connectors/`
- Original license: Apache-2.0, copyright 2026 General Action, Inc.

The preserved upstream license is in `LICENSE.iRock.md`. Every vendored module
was adapted for Rocky and is not an unmodified copy.

The code has been modified to accept only short-lived Rocky service assertions,
derive Composio users as `acct:<tenant uid>`, enforce one account per toolkit,
use Composio's post-July-2026 `connected_accounts.link()` flow, and return one
combined MCP endpoint named `composio`.

Run with one worker. The single-account check/create lock is process-local; the
single-VM deployment intentionally runs one connector service process.
