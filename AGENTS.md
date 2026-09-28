# Trace project workflow

- Work in focused task-sized changes, verify each task, and commit before moving
  to the next task. Do not push without a user request.
- Keep user-facing documentation in English with corresponding Korean files
  under `notes/ko`. Keep `docs/tools.md`, README, and MCP metadata aligned.
- Require an explicitly selected registered environment. Keep format decoding
  separate from scanning, metrics, CLI, and MCP; do not add provider assumptions
  to the shared extraction engine.
- Treat session stores as read-only. Never commit real transcripts, configuration,
  exports, credentials, dependencies, or compiled output. Use synthetic fixtures.
- Preserve evidence references and report partial/unsupported data. Execution
  timing requires actual boundaries; message gaps are not human work duration.
- Run `npm run typecheck` and appropriate tests (`npm test` for extraction or MCP
  changes). Stdio starts with `npm start` or `npm run start:stdio`; stdout belongs
  to MCP. Keep the JSON-export CLI separate.
- HTTP and tunnel transports are not implemented. When adding them, follow the
  workspace organization conventions and inspect Vault's launcher and guides;
  use Trace-specific settings and profiles, never Vault credentials.
