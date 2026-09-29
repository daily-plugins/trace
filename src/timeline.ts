import { z } from 'zod';
import { LocalSessionAdapter } from './extractor.js';
import { extractGitActivity } from './git.js';
import { selectEnvironment, selectRepository, type Config } from './config.js';

export const timelineSchema = z.object({
  from: z.iso.datetime({ offset: true }).optional(), to: z.iso.datetime({ offset: true }).optional(),
  environments: z.array(z.string()).optional(), repositories: z.array(z.string()).optional(),
  includeText: z.boolean().default(false), includePatch: z.boolean().default(false),
  includeWorkingTree: z.boolean().default(true), scanMode: z.enum(['auto', 'full']).default('auto'),
  limit: z.number().int().min(1).max(1000).default(100), offset: z.number().int().min(0).default(0),
});
type TimelineItem = { timestamp: string; sourceType: 'agent' | 'git'; source: string; root: string; id: string; data: unknown };
export async function extractTimeline(config: Config, input: unknown = {}) {
  const query = timelineSchema.parse(input);
  const to = query.to ?? new Date().toISOString();
  const from = query.from ?? new Date(Date.parse(to) - 86_400_000).toISOString();
  if (Date.parse(from) >= Date.parse(to)) throw new Error('from must be before to');
  const environments = query.environments === undefined ? config.environments : [...new Set(query.environments)].map(name => selectEnvironment(config, name));
  const repositories = query.repositories === undefined ? config.repositories ?? [] : [...new Set(query.repositories)].map(name => selectRepository(config, name));
  const tasks = [
    ...environments.map(value => ({ type: 'agent' as const, value })),
    ...repositories.map(value => ({ type: 'git' as const, value })),
  ];
  const timeline: TimelineItem[] = [];
  const currentChanges: { repository: string; root: string; state: unknown }[] = [];
  const sources: { type: string; name: string; root: string; incomplete: boolean; diagnostics: unknown[]; details?: unknown }[] = [];
  const diagnostics: string[] = [];
  let cursor = 0; let bytes = 0; const started = Date.now();
  const accept = (value: unknown) => {
    const size = Buffer.byteLength(JSON.stringify(value));
    if (bytes + size > 8 * 1024 * 1024) { if (!diagnostics.includes('timeline_output_limit')) diagnostics.push('timeline_output_limit'); return false; }
    bytes += size; return true;
  };
  async function worker() {
    while (cursor < tasks.length) {
      const index = cursor++; const task = tasks[index]!;
      if (index >= 100 || Date.now() - started >= 60_000) {
        sources.push({ type: task.type, name: task.value.name, root: task.value.root, incomplete: true, diagnostics: [index >= 100 ? 'source_limit' : 'timeline_time_budget'] });
        continue;
      }
      let active = false;
      const source = { type: task.type, name: task.value.name, root: task.value.root, incomplete: false, diagnostics: [] as unknown[], details: undefined as unknown };
      try {
        if (task.type === 'agent') {
          const result = await new LocalSessionAdapter(task.value).extract({ from, to, includeText: query.includeText, scanMode: query.scanMode, limit: 1000 });
          active = result.events.length > 0;
          source.incomplete = result.incomplete || result.nextOffset !== null;
          source.diagnostics = [...result.diagnostics, ...(result.nextOffset !== null ? [{ code: 'source_event_limit', nextOffset: result.nextOffset }] : [])];
          source.details = { scan: result.scan, metrics: result.metrics, sessionCount: result.sessions.length, eventCount: result.events.length };
          for (const event of result.events) {
            const item: TimelineItem = { timestamp: event.timestamp, sourceType: 'agent', source: task.value.name, root: task.value.root, id: event.id, data: event };
            if (!accept(item)) { source.incomplete = true; source.diagnostics.push('timeline_output_limit'); break; }
            timeline.push(item);
          }
        } else {
          const result = await extractGitActivity(task.value, { from, to, limit: 100, includePatch: query.includePatch, includeWorkingTree: query.includeWorkingTree });
          active = result.commits.length > 0 || (result.workingTree?.changes.length ?? 0) > 0;
          source.incomplete = result.incomplete; source.diagnostics = [...result.diagnostics];
          source.details = { head: result.head, scope: result.scope, commitCount: result.commits.length };
          for (const commit of result.commits) {
            const item: TimelineItem = { timestamp: commit.timestamp, sourceType: 'git', source: task.value.name, root: task.value.root, id: `${task.value.name}:${commit.hash}`, data: commit };
            if (!accept(item)) { source.incomplete = true; source.diagnostics.push('timeline_output_limit'); break; }
            timeline.push(item);
          }
          if (result.workingTree && result.workingTree.changes.length > 0) {
            const current = { repository: task.value.name, root: task.value.root, state: result.workingTree };
            if (accept(current)) currentChanges.push(current);
            else { source.incomplete = true; source.diagnostics.push('timeline_output_limit'); }
          }
        }
      } catch (error) {
        source.incomplete = true;
        source.diagnostics.push({ code: 'source_error', message: error instanceof Error ? error.message : 'Source failed' });
      }
      if (active || source.incomplete) sources.push(source);
    }
  }
  await Promise.all([worker(), worker()]);
  timeline.sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp) || a.sourceType.localeCompare(b.sourceType) || a.source.localeCompare(b.source) || a.id.localeCompare(b.id));
  sources.sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name));
  currentChanges.sort((a, b) => a.repository.localeCompare(b.repository));
  if (!tasks.length) diagnostics.push('no_registered_sources');
  return { range: { from, to }, sources, timeline: timeline.slice(query.offset, query.offset + query.limit), currentChanges,
    totalCollected: timeline.length, nextOffset: query.offset + query.limit < timeline.length ? query.offset + query.limit : null,
    incomplete: diagnostics.length > 0 || sources.some(s => s.incomplete), diagnostics };
}
