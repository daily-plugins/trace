# trace

Extract local agent sessions from an explicitly selected environment. Trace
normalizes activity into timestamped events with source file/line evidence.

Repository: [daily-plugins/trace](https://github.com/daily-plugins/trace).

## Supported sources

| Agent | Session root examples | Supported records |
| --- | --- | --- |
| Codex | `~/.codex/sessions` | Rollout JSONL: messages, tool names, explicit turn boundaries |
| Claude Code | `~/.claude/projects` | Transcript JSONL: messages, tool names, nested subagents |
| Antigravity | `~/.gemini/antigravity/brain`, `~/.gemini/antigravity-cli/brain`, `~/.gemini/antigravity-ide/brain` | Native `.system_generated/logs/transcript.jsonl`: user/planner messages and tool names |

These are **agent applications**, not model providers. Antigravity can use a
Claude model and still uses the Antigravity adapter. Each environment records
one agent and one root; register multiple environments for multiple installations.
Paths are examples, never automatically scanned. Older Antigravity `.pb`/`.db`
stores without a transcript are not decoded. Claude web/Desktop exports and
arbitrary API logs are not Claude Code transcripts.

Internal log formats are version-dependent. The adapters support the documented
record shapes in [the tool guide](docs/tools.md), not every version of each app.

## Start

Requires Node.js 20.20 or later.

```sh
npm ci
npm run build
npm run trace -- agents
```

Choose an environment and an existing session root. For example, register only
the sources you want to use:

```sh
npm run trace -- setup --environment work-codex --agent codex --root ~/.codex/sessions
npm run trace -- setup --environment work-claude --agent claude-code --root ~/.claude/projects
npm run trace -- setup --environment work-agy --agent antigravity --root ~/.gemini/antigravity-cli/brain
```

Setup stores metadata only; it does not extract sessions or change agent settings.
Configuration defaults to `~/.config/trace/config.json`. Override it using
`TRACE_CONFIG` or CLI `--config /absolute/path/config.json`. Existing names require
`--replace`. An unknown name or agent is an error; there is no implicit fallback.

```sh
npm run trace -- environments
npm run trace -- sessions --environment work-agy
npm run trace -- extract --environment work-codex \
  --from 2026-09-28T00:00:00+09:00 --to 2026-09-29T00:00:00+09:00 \
  --include-text --limit 100
```

The time range includes `from` and excludes `to`. Explicit timezones are required.
Text is opt-in and bounded to 4,000 characters per event. Use `nextOffset` for
subsequent event pages. For clean JSON redirection, invoke
`node dist/src/cli.js extract ...` directly or use `npm run --silent trace -- ...`.
Exit codes: 0 complete, 1 invalid request/configuration, 2 incomplete extraction.

## MCP

`npm start` and `npm run start:stdio` start the same local stdio MCP server.
Stdout is reserved for the protocol. Configure a local MCP client to launch:

```json
{
  "mcpServers": {
    "trace": {
      "command": "node",
      "args": ["/absolute/path/to/trace/dist/src/server.js"],
      "env": { "TRACE_CONFIG": "/absolute/path/to/trace-config.json" }
    }
  }
}
```

Available tools: `trace_activity` (default), `list_environments`, `list_local_sessions`, `extract_local_events`, `extract_git_activity`.
Unified queries use all registered sources; source-specific tools require a name. See [tool semantics](docs/tools.md).
Trace cannot read the calling host's own conversations. Server instructions, the
`trace_activity` result, and the `activity_review` prompt ask the host to review
its own chat history and merge it with Trace results; see [host conversations](docs/tools.md#host-conversations).
The plugin contains a skill and development manifest. Build the checkout and
configure the MCP connection explicitly; automatic marketplace installation,
HTTP is not implemented. Private tunnel startup is available through
`npm run tunnel:init`, `npm run tunnel:doctor`, and `npm run start:tunnel`
(`npm run remote` is an alias). Follow the [tunnel guide](docs/tunnel-connection.md)
for its separate client, profile, and runtime key. Local extraction itself needs
no account credentials or model API key.

## Meaning of time

- `observedSpanMs`: span between the first and last recognized timestamps in the
  entire source file. It includes gaps and is not time spent working.
- `turnExecutionMs`: union of known completed/aborted Codex turn intervals,
  clipped to the requested range. Open turns are not extrapolated. Turn wall time
  can include waiting and does not measure human attention or model compute time.
- Claude Code and Antigravity execution metrics are `null`: message timestamps
  alone do not establish execution boundaries. Legacy Codex files without turn
  boundaries also return `null`.
- Aggregate union and summed session durations are separate. Timing coverage
  counts show how many returned sessions have usable boundaries.

## Architecture and limits

`config.ts` selects a named environment; `adapters.ts` decodes its native records;
`extractor.ts` scans read-only snapshots, normalizes timestamps, computes known
intervals, and paginates; CLI and MCP expose that same engine.

Source files are never modified. Extraction makes no network calls and creates
no content database. Returning text through an MCP host makes it available to
that host. Message text is not a secret-redaction service. Tool arguments,
outputs, thinking blocks, and native system/developer messages are excluded;
arbitrary user/assistant text remains untrusted data.

Scans are bounded and report `incomplete`/`diagnostics`; a limit is not evidence
that no other activity exists. Auto scans skip logs last modified before `from`,
except Codex folders near the requested dates. Date-window files are read first,
then recently modified files, retaining old sessions resumed during the period.
`scan` reports candidate, skipped, read-file and byte counts. This assumes native
logs update mtime when events are appended. For imported archives with preserved
or unreliable mtimes, use `--scan-mode full` (MCP: `scanMode: "full"`) and a narrow
root if necessary. See the guide for resource limits.
There is no background collector, persistent index, remote session retrieval,
email/browser integration, or automatic summarizer yet.

```sh
npm run typecheck
npm test
```

Tests use synthetic temporary sessions and include the CLI and MCP handshake.
Codex and Antigravity parser shapes were also inspected locally; Claude Code has
fixture coverage, not a live installation verification in this workspace.

[한국어](notes/ko/README.md)

## Git file tracking

Register a Git working-tree root separately from agent environments:

```sh
npm run trace -- setup-git --repository project --root /absolute/path/to/project
npm run trace -- git-activity --repository project \
  --from 2026-09-29T00:00:00+09:00 --to 2026-09-30T00:00:00+09:00
```

MCP tool: `extract_git_activity`. It returns HEAD-reachable non-merge commit
history and changed paths using committer timestamps. `--include-working-tree`
adds current tracked/staged changes; their change time is unknown and they are
not date-filtered. `--include-patch` opts into bounded diffs. Untracked files are
excluded. There is no background collection or snapshot storage. Git 2.37+ is
required; see [limits and output semantics](docs/tools.md#git-file-activity).

Discover repositories beneath an explicitly selected parent directory:

```sh
npm run trace -- discover-git --root /absolute/path/to/projects
npm run trace -- discover-git --root /absolute/path/to/projects --register
```

The first command previews; `--register` adds discovered Git working trees in
one configuration update. Existing paths/names are preserved; duplicate folder
names receive numeric suffixes. Both `.git` directories and worktree `.git`
files are detected. This is a one-time scan, not a background watcher. For a
tunnel, select its pinned configuration using `--config /path/to/config.json`.
See [discovery limits](docs/tools.md#repository-discovery-cli).

## Default unified query

```sh
npm run trace -- --config .local/trace-config.json \
  --from 2026-09-29T00:00:00+09:00 --to 2026-09-30T00:00:00+09:00
```

No command, `timeline`, and `extract` without `--environment` query all registered
agent environments and Git repositories. MCP uses `trace_activity` by default.
Omitting dates selects the last 24 hours, not the local calendar day. Results
merge timestamped events in ascending order; current tracked Git changes are
separate. Inactive sources are omitted. Failed/partial sources retain diagnostics.
Use `--no-working-tree` to omit current changes. Text and patches remain opt-in.
See [unified query semantics](docs/tools.md#unified-activity-default).
