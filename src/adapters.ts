import { basename, dirname, join, sep } from 'node:path';
import type { Agent } from './config.js';
import type { ActivityEvent } from './types.js';

type Obj = Record<string, any>;
export const object = (v: unknown): Obj => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Obj : {};
const str = (v: unknown): string | undefined => typeof v === 'string' ? v : undefined;
export interface DecodedEvent {
  kind: ActivityEvent['kind']; actor: ActivityEvent['actor']; text?: string; tool?: string;
  dedupKey?: string; fallback?: boolean; sourceTruncated?: boolean;
}
export interface Decoded {
  recognized: boolean;
  timestamp?: string;
  sessionId?: string;
  cwd?: string;
  model?: string;
  events: DecodedEvent[];
  canonicalRole?: 'human' | 'agent';
  turn?: { id?: string; state: 'start' | 'completed' | 'aborted'; start?: string; end?: string };
}
export interface Decoder {
  executionTiming: 'explicit-turns' | 'unavailable';
  accepts(file: string): boolean;
  decode(record: Obj, absoluteFile: string): Decoded;
}
const textBlocks = (value: unknown): string | undefined => {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return undefined;
  const texts = value.filter(b => b && ['text', 'input_text', 'output_text'].includes(b.type) && typeof b.text === 'string').map(b => b.text);
  return texts.length ? texts.join('\n') : undefined;
};
const message = (actor: 'human' | 'agent', text?: string): DecodedEvent => ({ kind: actor === 'human' ? 'user_message' : 'assistant_message', actor, text });

const codex: Decoder = {
  executionTiming: 'explicit-turns', accepts: file => file.endsWith('.jsonl'),
  decode(r) {
    const p = object(r.payload);
    const d: Decoded = { recognized: ['session_meta', 'response_item', 'event_msg', 'turn_context'].includes(r.type), timestamp: str(r.timestamp), events: [] };
    if (r.type === 'session_meta') { d.sessionId = str(p.id) ?? str(p.session_id); d.cwd = str(p.cwd); }
    if (r.type === 'turn_context') { d.cwd = str(p.cwd); d.model = str(p.model); }
    if (r.type === 'response_item' && p.type === 'message' && ['user', 'assistant'].includes(p.role)) {
      const actor = p.role === 'user' ? 'human' : 'agent';
      const text = textBlocks(p.content);
      d.canonicalRole = actor;
      // Known injected context envelopes are not user work. Arbitrary text remains untrusted data.
      if (actor === 'human' && text && /^(?:<environment_context>|<user_instructions>|# AGENTS\.md instructions)/.test(text.trimStart())) return d;
      d.events.push({ ...message(actor, text), dedupKey: str(p.id) });
    }
    if (r.type === 'response_item' && ['function_call', 'custom_tool_call'].includes(p.type)) {
      d.events.push({ kind: 'tool_call', actor: 'agent', tool: str(p.name) ?? 'unknown', dedupKey: str(p.call_id) ?? str(p.id) });
    }
    if (r.type === 'event_msg') {
      if (p.type === 'user_message' || p.type === 'agent_message') d.events.push({ ...message(p.type === 'user_message' ? 'human' : 'agent', str(p.message)), fallback: true });
      if (['task_started', 'task_complete', 'turn_aborted'].includes(p.type)) {
        const state = p.type === 'task_started' ? 'start' : p.type === 'task_complete' ? 'completed' : 'aborted';
        d.turn = { id: str(p.turn_id), state, start: str(p.started_at), end: str(p.completed_at) };
        d.events.push({ kind: state === 'start' ? 'turn_started' : state === 'completed' ? 'turn_completed' : 'turn_aborted', actor: 'agent', dedupKey: str(p.turn_id) });
      }
    }
    return d;
  },
};

const claude: Decoder = {
  executionTiming: 'unavailable', accepts: file => file.endsWith('.jsonl'),
  decode(r, file) {
    const m = object(r.message);
    let sessionId = str(r.sessionId);
    // A subagent shares its parent's sessionId but is a separate activity stream.
    if (sessionId && file.split(sep).includes('subagents')) sessionId += `/${str(r.agentId) ?? basename(file, '.jsonl')}`;
    const d: Decoded = { recognized: typeof r.sessionId === 'string' && ['user', 'assistant', 'system', 'progress', 'summary'].includes(r.type), timestamp: str(r.timestamp), sessionId, cwd: str(r.cwd), model: str(m.model), events: [] };
    if (r.isMeta === true || !['user', 'assistant'].includes(r.type)) return d;
    const actor = r.type === 'user' ? 'human' : 'agent';
    const text = textBlocks(m.content);
    if (text !== undefined) d.events.push({ ...message(actor, text), dedupKey: str(r.uuid) });
    if (actor === 'agent' && Array.isArray(m.content)) {
      for (const b of m.content) if (b?.type === 'tool_use') d.events.push({ kind: 'tool_call', actor, tool: str(b.name) ?? 'unknown', dedupKey: str(b.id) });
    }
    return d;
  },
};

const antigravity: Decoder = {
  executionTiming: 'unavailable', accepts: file => basename(file) === 'transcript.jsonl',
  decode(r, file) {
    const recognized = ['USER_INPUT', 'PLANNER_RESPONSE', 'GENERIC', 'SYSTEM_MESSAGE'].includes(r.type);
    const d: Decoded = { recognized, timestamp: str(r.created_at), events: [] };
    if (!recognized) return d;
    // Official path: brain/<conversationId>/.system_generated/logs/transcript.jsonl.
    const suffix = `${sep}.system_generated${sep}logs${sep}transcript.jsonl`;
    d.sessionId = file.endsWith(suffix) ? basename(file.slice(0, -suffix.length)) : basename(dirname(file));
    if (r.type === 'USER_INPUT') d.events.push({ ...message('human', str(r.content)), dedupKey: String(r.step_index ?? ''), sourceTruncated: Array.isArray(r.truncated_fields) && r.truncated_fields.includes('content') });
    if (r.type === 'PLANNER_RESPONSE') {
      if (typeof r.content === 'string') d.events.push({ ...message('agent', r.content), dedupKey: String(r.step_index ?? '') });
      if (Array.isArray(r.tool_calls)) r.tool_calls.forEach((tool, i) => {
        if (typeof tool?.name === 'string') d.events.push({ kind: 'tool_call', actor: 'agent', tool: tool.name, dedupKey: `${r.step_index ?? ''}:${i}` });
      });
    }
    // GENERIC includes tool output and SYSTEM_MESSAGE includes injected context.
    return d;
  },
};

export const adapters: Record<Agent, Decoder> = { codex, 'claude-code': claude, antigravity };
export const adapterCatalog = [
  { agent: 'codex', format: 'Codex rollout JSONL', suggestedRoot: '~/.codex/sessions', timing: 'explicit turn boundaries' },
  { agent: 'claude-code', format: 'Claude Code transcript JSONL', suggestedRoot: '~/.claude/projects', timing: 'message timestamps; execution duration unavailable' },
  { agent: 'antigravity', format: 'Antigravity transcript.jsonl', suggestedRoots: ['~/.gemini/antigravity/brain', '~/.gemini/antigravity-cli/brain', '~/.gemini/antigravity-ide/brain'], timing: 'step timestamps; execution duration unavailable' },
] as const;
