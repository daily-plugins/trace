import type { Agent } from './config.js';
export interface Evidence { file: string; line: number }
export interface ActivityEvent {
  id: string;
  timestamp: string;
  kind: 'user_message' | 'assistant_message' | 'tool_call' | 'turn_started' | 'turn_completed' | 'turn_aborted';
  actor: 'human' | 'agent';
  text?: string;
  textTruncated?: boolean;
  tool?: string;
  evidence: Evidence;
}
export interface Turn {
  id: string;
  start: string;
  end: string | null;
  status: 'completed' | 'aborted' | 'open';
  elapsedMs: number | null;
}
export interface Session {
  id: string;
  source: Agent;
  file: string;
  cwd: string | null;
  model: string | null;
  firstObservedAt: string | null;
  lastObservedAt: string | null;
  observedSpanMs: number | null;
  turnExecutionMs: number | null;
  executionTiming: 'explicit-turns' | 'unavailable';
  openTurns: number | null;
  counts: Record<ActivityEvent['kind'], number>;
}
export interface Query {
  scanMode?: 'auto' | 'full';
  from?: string;
  to?: string;
  sessionId?: string;
  includeText?: boolean;
  limit?: number;
  offset?: number;
}
export interface Diagnostic { file?: string; code: string; count?: number }
export interface Extraction {
  source: Agent;
  environment: string;
  root: string;
  scan: { strategy: 'mtime-assisted' | 'full'; discoveredFiles: number; skippedBeforeRange: number; candidateFiles: number; readFiles: number; bytesRead: number };
  range: { from: string | null; to: string | null };
  sessions: Session[];
  events: (ActivityEvent & { sessionId: string })[];
  metrics: { turnExecutionUnionMs: number | null; summedSessionTurnExecutionMs: number | null; sessionsWithTiming: number; sessionsWithoutTiming: number };
  nextOffset: number | null;
  diagnostics: Diagnostic[];
  incomplete: boolean;
}
export interface SessionAdapter { extract(query?: Query): Promise<Extraction> }
