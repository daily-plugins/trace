import { constants } from 'node:fs';
import { open, readdir, realpath } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { createHash } from 'node:crypto';
import type { ActivityEvent, Diagnostic, Extraction, Query, Session, SessionAdapter, Turn } from './types.js';
import type { Environment } from './config.js';
import { adapters, object } from './adapters.js';

const iso = (v: unknown): string | null => {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(v)) return null;
  const n = Date.parse(v);
  return Number.isFinite(n) ? new Date(n).toISOString() : null;
};
export function bounds(q: Query): [number, number] {
  if ((q.from !== undefined && !iso(q.from)) || (q.to !== undefined && !iso(q.to))) throw new Error('Use ISO timestamps with an explicit timezone.');
  const from = q.from ? Date.parse(q.from) : -Infinity;
  const to = q.to ? Date.parse(q.to) : Infinity;
  if (from >= to) throw new Error('from must be earlier than to.');
  if (q.limit !== undefined && (!Number.isInteger(q.limit) || q.limit < 1 || q.limit > 1000)) throw new Error('limit must be 1..1000.');
  if (q.offset !== undefined && (!Number.isSafeInteger(q.offset) || q.offset < 0)) throw new Error('offset must be a nonnegative integer.');
  return [from, to];
}
export function unionMs(intervals: [number, number][]): number {
  let total = 0, end = -Infinity;
  for (const [a, b] of intervals.sort((x, y) => x[0] - y[0])) {
    if (b > a) { total += Math.max(0, b - Math.max(a, end)); end = Math.max(end, b); }
  }
  return total;
}
const MAX_FILES = 1000, MAX_FILE_BYTES = 64 * 1024 * 1024, MAX_SCAN_BYTES = 256 * 1024 * 1024;
const MAX_EVENTS = 100_000;

export class LocalSessionAdapter implements SessionAdapter {
  constructor(private environment: Environment) {}
  async extract(q: Query = {}): Promise<Extraction> {
    const [from, to] = bounds(q);
    const diagnostics: Diagnostic[] = [];
    let root = resolve(this.environment.root);
    const decoder = adapters[this.environment.agent];
    const measured = decoder.executionTiming === 'explicit-turns';
    const result: Extraction = {
      source: this.environment.agent, environment: this.environment.name, root, range: { from: q.from ? iso(q.from) : null, to: q.to ? iso(q.to) : null },
      sessions: [], events: [], metrics: { turnExecutionUnionMs: null, summedSessionTurnExecutionMs: null, sessionsWithTiming: 0, sessionsWithoutTiming: 0 },
      nextOffset: null, diagnostics, incomplete: false,
    };
    try { root = await realpath(root); result.root = root; }
    catch { diagnostics.push({ code: 'source_unavailable' }); result.incomplete = true; return result; }
    const files: string[] = [];
    let entries = 0, stopped = false;
    const walk = async (dir: string, depth: number): Promise<void> => {
      if (stopped) return;
      if (depth > 10) { diagnostics.push({ code: 'depth_limit' }); return; }
      let children;
      try { children = await readdir(dir, { withFileTypes: true }); }
      catch { diagnostics.push({ file: relative(root, dir), code: 'directory_unreadable' }); return; }
      children.sort((a, b) => a.name.localeCompare(b.name));
      for (const item of children) {
        if (stopped) break;
        if (++entries > 20_000 || files.length >= MAX_FILES) { diagnostics.push({ code: 'scan_limit' }); stopped = true; break; }
        const path = join(dir, item.name);
        if (item.isSymbolicLink()) continue;
        if (item.isDirectory()) await walk(path, depth + 1);
        else if (item.isFile() && decoder.accepts(path)) files.push(path);
      }
    };
    await walk(root, 0);
    if (!files.length) diagnostics.push({ code: 'no_supported_files' });
    let scanBytes = 0;
    const allIntervals: [number, number][] = [];
    for (const path of files) {
      const file = relative(root, path);
      let handle;
      try {
        handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
        const stat = await handle.stat();
        if (!stat.isFile() || stat.nlink !== 1) { diagnostics.push({ file, code: 'unsupported_file' }); continue; }
        if (stat.size > MAX_FILE_BYTES) { diagnostics.push({ file, code: 'file_size_limit' }); continue; }
        if (scanBytes + stat.size > MAX_SCAN_BYTES) { diagnostics.push({ code: 'byte_limit' }); break; }
        scanBytes += stat.size;
        if (!stat.size) continue;
        // Fixed end prevents reading our own newly appended output indefinitely.
        const lines = createInterface({ input: handle.createReadStream({ end: stat.size - 1, autoClose: false }), crlfDelay: Infinity });
        const fallbackId = createHash('sha256').update(`${this.environment.name}:${file}`).digest('hex').slice(0, 24);
        let id = fallbackId, cwd: string | null = null, model: string | null = null;
        let first: string | null = null, last: string | null = null;
        let lineNumber = 0, malformed = 0, seenMetadata = false;
        const canonicalRoles = new Set<string>();
        const seenEvents = new Set<string>();
        let recognizedRecords = 0, invalidTimestamps = 0;
        const events: ActivityEvent[] = [], fallbackMessages: ActivityEvent[] = [];
        const turns = new Map<string, Turn>();
        let currentTurn: string | null = null;
        let eventLimit = false;
        for await (const line of lines) {
          lineNumber++;
          if (!line.trim()) continue;
          let record;
          try { record = object(JSON.parse(line)); } catch { malformed++; continue; }
          const decoded = decoder.decode(record, path);
          if (!decoded.recognized) continue;
          recognizedRecords++;
          if (decoded.sessionId) { seenMetadata = true; id = decoded.sessionId; }
          cwd = decoded.cwd ?? cwd; model = decoded.model ?? model;
          if (decoded.canonicalRole) canonicalRoles.add(decoded.canonicalRole);
          const timestamp = iso(decoded.timestamp);
          if (!timestamp) { if (decoded.events.length) invalidTimestamps++; continue; }
          if (first === null || timestamp < first) first = timestamp;
          if (last === null || timestamp > last) last = timestamp;
          for (const [index, e] of decoded.events.entries()) {
            const dedup = e.dedupKey ? `${e.kind}:${e.dedupKey}` : null;
            if (dedup && seenEvents.has(dedup)) continue;
            if (dedup) seenEvents.add(dedup);
            const event: ActivityEvent = {
              id: `${this.environment.agent}:${fallbackId}:${lineNumber}:${index}`,
              timestamp, kind: e.kind, actor: e.actor,
              ...(e.tool ? { tool: e.tool } : {}),
              ...(q.includeText && e.text !== undefined ? { text: e.text.slice(0, 4000), textTruncated: e.text.length > 4000 || e.sourceTruncated === true } : {}),
              evidence: { file, line: lineNumber },
            };
            (e.fallback ? fallbackMessages : events).push(event);
          }
          if (decoded.turn) {
            const t = decoded.turn;
            const turnId: string = t.id ?? currentTurn ?? `line-${lineNumber}`;
            if (t.state === 'start') {
              currentTurn = turnId;
              if (!turns.has(turnId)) turns.set(turnId, { id: turnId, start: iso(t.start) ?? timestamp, end: null, status: 'open', elapsedMs: null });
            } else {
              const start = turns.get(turnId)?.start ?? iso(t.start);
              const end = iso(t.end) ?? timestamp;
              if (start && end >= start) turns.set(turnId, { id: turnId, start, end, status: t.state, elapsedMs: Date.parse(end) - Date.parse(start) });
              else diagnostics.push({ file, code: 'unmatched_turn_end' });
              if (currentTurn === turnId) currentTurn = null;
            }
          }
          if (events.length + fallbackMessages.length >= MAX_EVENTS) { eventLimit = true; lines.close(); break; }
        }
        if (malformed) diagnostics.push({ file, code: 'malformed_jsonl', count: malformed });
        if (eventLimit) diagnostics.push({ file, code: 'event_limit' });
        if (invalidTimestamps) diagnostics.push({ file, code: 'invalid_timestamp', count: invalidTimestamps });
        if (!recognizedRecords) { diagnostics.push({ file, code: 'unsupported_format' }); continue; }
        if (!seenMetadata) { diagnostics.push({ file, code: 'missing_session_metadata' }); continue; }
        if (q.sessionId && q.sessionId !== id) continue;
        const selected = [...events, ...fallbackMessages.filter(e => !canonicalRoles.has(e.actor))].filter(e => Date.parse(e.timestamp) >= from && Date.parse(e.timestamp) < to);
        const intervals: [number, number][] = [];
        for (const t of turns.values()) {
          if (t.end) { const a = Math.max(from, Date.parse(t.start)), b = Math.min(to, Date.parse(t.end)); if (b > a) intervals.push([a, b]); }
        }
        if (!selected.length && !intervals.length && (q.from || q.to)) continue;
        const counts: Session['counts'] = { user_message: 0, assistant_message: 0, tool_call: 0, turn_started: 0, turn_completed: 0, turn_aborted: 0 };
        for (const e of selected) counts[e.kind]++;
        const turnExecutionMs = unionMs(intervals);
        const hasTiming = measured && turns.size > 0;
        result.sessions.push({ id, source: this.environment.agent, file, cwd, model, firstObservedAt: first, lastObservedAt: last,
          observedSpanMs: first && last ? Date.parse(last) - Date.parse(first) : null,
          turnExecutionMs: hasTiming ? turnExecutionMs : null, executionTiming: hasTiming ? 'explicit-turns' : 'unavailable',
          openTurns: hasTiming ? [...turns.values()].filter(t => !t.end && Date.parse(t.start) < to).length : null, counts });
        for (const e of selected) result.events.push({ ...e, sessionId: id });
        allIntervals.push(...intervals);
        if (hasTiming) {
          result.metrics.sessionsWithTiming++;
          result.metrics.summedSessionTurnExecutionMs = (result.metrics.summedSessionTurnExecutionMs ?? 0) + turnExecutionMs;
        } else result.metrics.sessionsWithoutTiming++;
        if (result.events.length >= MAX_EVENTS) { diagnostics.push({ code: 'total_event_limit' }); break; }
      } catch { diagnostics.push({ file, code: 'file_unreadable' }); }
      finally { await handle?.close(); }
    }
    result.sessions.sort((a, b) => (b.lastObservedAt ?? '').localeCompare(a.lastObservedAt ?? '') || a.file.localeCompare(b.file));
    result.events.sort((a, b) => a.timestamp.localeCompare(b.timestamp) || a.evidence.file.localeCompare(b.evidence.file) || a.evidence.line - b.evidence.line);
    const offset = q.offset ?? 0, limit = q.limit ?? 100;
    result.nextOffset = offset + limit < result.events.length ? offset + limit : null;
    result.events = result.events.slice(offset, offset + limit);
    result.metrics.turnExecutionUnionMs = result.metrics.sessionsWithTiming ? unionMs(allIntervals) : null;
    result.incomplete = diagnostics.length > 0;
    return result;
  }
}
