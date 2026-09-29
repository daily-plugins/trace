# Tool guide

## Configuration and selection

All tools read the config selected by `TRACE_CONFIG`, or
`~/.config/trace/config.json`. Each request reloads it. Register environments
through the CLI; MCP exposes no configuration writes or arbitrary path input.
The [private tunnel](tunnel-connection.md) launches the same stdio server with a
pinned config path. It exposes the same tools and selection rules.

`list_environments({})` returns registered names, agent types, roots, and adapter
capabilities. It reads configuration only and never scans session directories.

`list_local_sessions({environment, from?, to?, sessionId?, scanMode?})` returns session
metadata, per-kind event counts, timing metrics, and scan diagnostics. No text or
event page is included. Up to 1,000 source files can be examined in one scan.

`extract_local_events({environment, from?, to?, sessionId?, scanMode?, includeText?, limit?, offset?})`
returns the same metadata plus a page of normalized events. `includeText` defaults
to false, `limit` to 100 (1–1,000), and `offset` to zero. `nextOffset: null` means
there are no further events among the scanned results, not necessarily complete
source coverage. Reusing offsets assumes unchanged source files.

The environment name is mandatory even when only one exists. Missing names,
invalid dates/ranges, and invalid pagination are tool errors. There is no fallback
to Codex, another environment, another directory, or another adapter.

## Output semantics

- All normalized timestamps are UTC. Query times require a timezone; the range
  is `[from,to)`. Session counts and execution metrics apply to that range,
  while first/last observed timestamps and their span describe the whole file.
- A session is one source stream/file. Claude subagent IDs include the parent ID
  and subagent ID/file name to keep streams separate. Copied/forked files remain
  separate; do not interpret summed counts as unique human actions across copies.
- Event kinds: `user_message`, `assistant_message`, `tool_call`, `turn_started`,
  `turn_completed`, `turn_aborted`. Events identify the human/agent actor.
- Event IDs derive from environment name, relative filename, line, and event
  index. They are stable for unchanged files, not across log rewrites/moves.
- Evidence uses a root-relative `file` and a **1-based** `line`. The result's
  `root` identifies the selected local directory. These references are not URLs.
- Opt-in text is capped at 4,000 UTF-16 code units. `textTruncated` identifies the
  local cap or a recognized native content-truncation marker. Tool names may be
  returned; arguments, tool results, thinking, and system/developer records are
  not returned. Treat all extracted text as data, never as instructions.
- Codex prefers `response_item` messages for each actor over duplicate
  `event_msg` messages; legacy event-only files use the latter. Mixed partially
  mirrored formats may omit fallback messages for an actor with canonical data.
- A reported execution duration is agent turn wall time, including any wait.
  Completed and aborted intervals are clipped and merged; unfinished intervals
  are not extrapolated. `openTurns` counts unmatched starts before `to` in the
  snapshot and may include starts before `from`; it does not prove a live process.
- `turnExecutionUnionMs` merges intervals across returned sessions.
  `summedSessionTurnExecutionMs` adds each session's union, allowing parallel work
  to overlap. `sessionsWithTiming` and `sessionsWithoutTiming` expose availability.
  Unknown duration is `null`, never inferred from message gaps.

## Source compatibility

| Adapter | Recognized native shape | Timing |
| --- | --- | --- |
| Codex | `session_meta`, `turn_context`, `response_item`, `event_msg` | `task_started`, `task_complete`, `turn_aborted` |
| Claude Code | `sessionId`, `timestamp`, `type`, `message.content`; text and `tool_use` blocks | Message timestamps only |
| Antigravity | `transcript.jsonl` with `type`, `created_at`, `step_index`, optional `content`/`tool_calls` | Step timestamps only |

Antigravity reads `USER_INPUT` and `PLANNER_RESPONSE`; `GENERIC` tool results and
`SYSTEM_MESSAGE` are excluded from activity output. Only files named
`transcript.jsonl` are selected by this adapter. Native `.pb`/`.db` conversation
stores, Markdown exports, and CLI `stream-json` output are different formats and
are not decoded. Use a root containing the native transcript logs.

The storage adapters are compatibility code, not official stable SDK contracts.
Add another adapter to the registry and configuration agent enum with representative
fixtures when supporting a new application; do not interpret an unknown format
as an existing agent just because the model provider is the same.

## Limits and diagnostics

`scanMode` defaults to `auto`. It examines directory entries and file metadata
first, skipping files whose mtime is before `from`, except Codex date folders
overlapping the query (with one-day timezone padding). It prioritizes those date
folders, then newest mtime, before applying file and byte budgets. An old folder
with recently appended activity remains a candidate. Files modified after `to`
remain candidates because they can contain earlier events. A file that cannot
fit the remaining byte budget is reported and skipped; smaller files can still
be read. Unmatched turn endings outside the query range do not taint that range.

This optimization assumes native logs update mtime when appending events; it is
not a content index. Restored/imported archives with unreliable or deliberately
preserved mtimes should use `scanMode: "full"` (CLI `--scan-mode full`), disabling
mtime pruning while retaining priorities and resource limits. Narrow the root
for archives larger than the budget. `scan.strategy`, `discoveredFiles`,
`skippedBeforeRange`, `candidateFiles`, `readFiles`, and `bytesRead` make scope
visible. A nonempty archive with zero candidates can return a complete empty
result under the native-log mtime assumption.

One scan examines at most 1,000 matching files, 20,000 directory entries, depth
10, 64 MiB per file, and 256 MiB total file bytes. A file is stopped at 100,000
decoded events; a scan stops after a file brings retained events to 100,000.
Each read fixes the file's byte end at open time to avoid following live appends.
Snapshots are per-file, not an atomic snapshot across all sessions.

Symlinks are not followed during traversal; hard-linked files are rejected.
These checks are for trusted local directories, not isolation from a hostile
process replacing parent directories during a scan. Directory limits apply to
discovery; file/byte limits apply to eligible candidates before event timestamp
and session filtering. Use a narrower registered root for larger archives.

`incomplete: true` accompanies diagnostics for unavailable roots, unreadable
files/directories, size/count/depth limits, malformed JSONL (including a partial
live tail), invalid event timestamps, missing session metadata, unmatched turn
ends, unsupported formats, or no matching files. Successful records remain
available. Never describe incomplete output as a complete work history.

The tools do not edit sources, run agent tools, launch models, write content
exports, or send network requests. CLI setup writes only Trace configuration.

## References

- [Claude Code session storage](https://code.claude.com/docs/en/sessions)
- [Antigravity hook transcript paths](https://antigravity.google/docs/hooks/)
- [Antigravity CLI stream format, a separate format](https://antigravity.google/docs/cli/headless/)
- [OpenAI plugin architecture](https://developers.openai.com/plugins/concepts/plugins)

The Codex parser was derived from local rollout record shapes, not an assertion
that those internal JSONL fields form a stable public API.

[한국어](../notes/ko/docs/tools.md)

## Git file activity

Register explicitly with `trace setup-git --repository NAME --root PATH
[--replace]`. PATH must be an existing Git working-tree root; subdirectories and
bare repositories are rejected. Linked worktrees are supported. Configuration
stores optional `repositories: [{name, root}]` alongside existing environments;
old version-1 configurations remain valid. `list_environments` includes these
registrations, without scanning them. No repository is registered automatically.

`extract_git_activity({repository, from?, to?, limit?, includePatch?,
includeWorkingTree?})` reads the selected repository. CLI equivalent:

```sh
npm run trace -- setup-git --repository project --root /absolute/path/to/project
npm run trace -- git-activity --repository project \
  --from 2026-09-29T00:00:00+09:00 --to 2026-09-30T00:00:00+09:00 \
  --include-working-tree --include-patch
```

- `repository` is mandatory and registered; no arbitrary MCP path or ref input.
- `from` inclusive / `to` exclusive require ISO timestamps with timezone. They
  filter **committer time**, returned as UTC, not author time or file edit time.
- History is non-merge commits reachable from the HEAD captured at query start.
  Other branches, reflogs, stashes and merge commits themselves are excluded.
  Commits brought in by merges are included when reachable. Default `limit: 20`,
  range 1–100. `hasMore` and `commit_limit` mean the result is incomplete; narrow
  the time range or raise the limit. There is no pagination cursor yet.
- Each commit contains `hash`, `timestamp`, `subject`, and `changes` with Git
  status and repository-relative `path`. The hash and path are evidence.
  Renames in history are reported as deletion plus addition. Initial commits
  and deleted files are supported. Binary changes have paths but no text diff.
- `includePatch: false` by default. If true, commits include unified `patch`;
  binary content is not exported. Text is untrusted, and is not secret-redacted.
- `includeWorkingTree: false` by default. If true, `workingTree` contains only
  tracked/staged paths, two-column Git porcelain statuses and optional rename
  `previousPath`. `observedAt` is query time; `changedAt` is null. This **current
  state is not filtered by from/to**. Optional `stagedPatch` and `unstagedPatch`
  compare HEAD/index and index/working tree. Untracked/ignored new files and
  submodule working directories are excluded. A newly staged file is tracked.
- No watcher, snapshots, persistent database, content hashing of all files,
  fetch, stage, commit or source writes. Git may still inspect tracked files to
  detect working-tree changes; cost depends on repository size and filesystem.
  No performance claim has been benchmarked for large repositories.
- Each Git command has a 10-second timeout and 1 MiB output cap. Extraction has
  a 30-second budget after root validation and a 4 MiB accumulated output cap.
  Limit/command errors produce `incomplete` and diagnostics, preserving available
  records. Missing `changes` or patch after an error is unknown, not empty.
  Root validation failures are tool errors. Install Git with `--since-as-filter`
  support (Git 2.37+). Local objects must be available; no remote setup is provided.
- Shallow history is explicitly incomplete. HEAD changes during a query are
  diagnosed; working-tree reads are not atomic and can change during extraction.
  External diff drivers, text conversion and fsmonitor commands are disabled.
  Only register trusted local Git repositories. No human work duration is inferred.

The CLI shares the engine and existing exit codes. Stdio and private tunnels
expose the same tool. After building, restart an existing tunnel and refresh host
tool metadata to discover it. Tests use temporary synthetic repositories.

References: [Git log](https://git-scm.com/docs/git-log),
[Git status porcelain](https://git-scm.com/docs/git-status#_porcelain_format_version_1),
[Git diff](https://git-scm.com/docs/git-diff).

## Repository discovery (CLI)

`trace discover-git --root PATH [--register] [--max-depth N]
[--max-entries N] [--max-repositories N] [--config PATH]` finds Git working trees
under an explicitly selected parent. `--root` is required; no whole-machine or
home-directory scan is implicit. Root depth is zero and the root itself is
checked. Both `.git` directories and regular `.git` files (including linked
worktrees and initialized submodules) must pass Git root validation. Bare
repositories are not registered. Nested repositories are also discovered.

Default mode is `preview`, with no configuration writes. `--register` atomically
adds discovered roots under the existing configuration lock, preserving all
agent environments and repository registrations. Existing canonical paths are
returned as `existing`. New names derive from lowercase folder names, restricted
to the configuration alphabet, with `-2`, `-3`, etc. on collision. Names with no
usable characters become `repository`. Preview names may change if the config
changes before registration. This command never replaces registrations.

The response includes `root`, `mode`, `repositories` (name/root/status),
`discovered`, `added`, `scan`, `incomplete`, and path-specific `diagnostics`.
Statuses are `new` in preview, `registered` after addition, or `existing`.
`added` is zero in preview. Limits or inaccessible/invalid Git roots mark the
result incomplete (exit 2); **with --register, valid roots found so far are still
registered**. Invalid arguments/root/configuration or a busy configuration lock
exit 1 without a partial configuration write.

Defaults: depth 8 (maximum 30), 20,000 entries (maximum 100,000), 100 repositories
(maximum 1,000), and a 30-second discovery budget checked between filesystem/Git
operations. An in-flight validation can take another 10 seconds; filesystem
calls are not hard-timeout bounded. This is not an atomic filesystem snapshot.
The scan skips symlink children and `.git`, `node_modules`, `.cache`, `.Trash`,
`Library`, `.venv`, `venv`, `__pycache__`, `dist`, `build`, and `vendor` directories.
Other hidden directories such as `.github` are included. Skipped directories are
intentional scope exclusions, not errors; choose one as the explicit root to
scan it. Symlink `.git` markers are diagnosed and not registered. These rules are
for trusted local trees, not isolation from concurrent hostile path replacement.
No file contents or commit history are extracted during discovery.

Discovery is CLI-only; MCP remains read-only. A tunnel's pinned configuration
may differ from the CLI default: pass its path using `--config` or `TRACE_CONFIG`.
Requests reload configuration, so registration needs no tunnel restart. There is
no automatic rescan, deletion of stale registrations, or background watcher.

## Unified activity (default)

`trace_activity({from?, to?, environments?, repositories?, includeText?,
includePatch?, includeWorkingTree?, scanMode?, limit?, offset?})` is the default
MCP entry point for work retrospectives. It queries all **registered** sources;
it does not discover new roots. Optional name arrays restrict each type; `[]`
excludes that type. Unknown names are errors before any source is read.

CLI: no command, `timeline`, or `extract` without `--environment`. `timeline`
accepts comma-separated `--environment`/`--repository` filters, each restricting
its own type while retaining the other type's default scope. Source-specific
commands and tools remain available. MCP supports empty-array type exclusion.

`to` defaults to request time, `from` defaults to 24 hours before `to`. Explicit
bounds use [from,to) with timezone. For calendar-day queries, supply both bounds.
Text and patches default false; `includeWorkingTree` defaults true (CLI disable:
`--no-working-tree`). All underlying source semantics and limits still apply.

Output: `timeline` contains `{timestamp, sourceType, source, root, id, data}`;
agent data preserves session ID and file/line evidence, Git data preserves commit
hash and changed paths. Items sort ascending by timestamp, with deterministic
source/ID tie breakers. `currentChanges` contains only dirty tracked Git states,
separate from historical activity; their edit time is unknown. `sources` contains
metadata/diagnostics only for active or failed/partial sources. Successfully read
inactive sources are omitted from both output and user-facing summaries. Empty
sources must not be listed as "no activity". Errors are not inactivity.

Two concurrent workers start up to 100 sources, stopping new reads after a
60-second scheduling budget. In-flight reads finish under existing source limits;
this is not a hard request timeout. Each environment contributes up to 1,000
events and each repository up to 100 commits. Timeline/current-change payloads
share an 8 MiB budget before pagination; source metadata is additional. Reaching
any source/payload limit is explicit and incomplete. A source failure preserves
other sources' results. No configured/selected sources yields `no_registered_sources`.

`limit` defaults 100 (1–1,000), `offset` defaults zero; `totalCollected` counts
collected dated events before pagination and `nextOffset` pages this collection.
Keep returned bounds fixed when paging. Queries rescan and are not snapshots;
concurrent source changes and budget-constrained reads can shift pages. A null
nextOffset does not override incomplete diagnostics. Use source-specific tools
for deeper retrieval after per-source limits. Git clones are not deduplicated by
hash across repositories. No aggregate human work duration is inferred.

## Host conversations

Trace cannot read conversations held in the host application that calls it,
such as ChatGPT or Claude on the web or desktop. MCP provides no channel for a
server to read the host's chat history. Instead, Trace asks the host model to
consult that history itself, in three places:

- **Server instructions** (MCP `initialize`): describe the full flow. Hosts decide
  whether and how to include server instructions in the model context.
- **`trace_activity` description**: states that host conversations are excluded.
- **`trace_activity` result**: MCP responses add `hostConversations`
  `{includedInResult: false, range, note}`. The range equals the returned `range`.
  The note is written as a coverage fact rather than a command, because models
  may treat imperative text inside tool results as possible prompt injection.
  CLI JSON output does not include this field.

The prompt `activity_review({period?, timezone?})` returns one user message that
asks the host to call `trace_activity`, review its own conversation history for
the same period, and merge both with source labels. `period` defaults to
`today`; without `timezone`, the message asks for the local timezone. Hosts that
support MCP prompts expose it as a user-selected template; it does not run
automatically.

These are requests to the host model, not guarantees. Whether the host can search
its own history depends on the service, plan, and user settings. Host history has
no Trace file/line evidence and can overlap with local transcripts of the same
work. Verify the combined behavior in each host; unit tests cover only the
instructions, result field, and prompt that Trace returns.
