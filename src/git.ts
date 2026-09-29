import { execFile } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { z } from 'zod';
import type { Repository } from './config.js';

// Ignore inherited repository overrides; never run external diff/text conversion or lazy fetch.
async function git(root: string, args: string[], budgetMs = 10_000): Promise<string> {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  return new Promise((resolve, reject) => {
    execFile('git', ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', 'core.pager=cat', '-C', root, ...args], {
      env: { ...env, GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
      encoding: 'utf8', timeout: Math.max(1, Math.min(10_000, budgetMs)), maxBuffer: 1024 * 1024,
    }, (error, stdout) => error ? reject(new Error(error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' ? 'git_output_limit' : error.killed ? 'git_timeout' : 'git_command_failed')) : resolve(stdout));
  });
}
export async function validateRepository(root: string): Promise<string> {
  try {
    const canonical = await realpath(root);
    const top = (await git(canonical, ['rev-parse', '--show-toplevel'])).trimEnd();
    if (await realpath(top) !== canonical) throw new Error();
    return canonical;
  } catch { throw new Error('Select an accessible Git working-tree root (not a subdirectory or bare repository).'); }
}
const date = z.iso.datetime({ offset: true });
export const gitQuerySchema = z.object({
  from: date.optional(), to: date.optional(), limit: z.number().int().min(1).max(100).default(20),
  includePatch: z.boolean().default(false), includeWorkingTree: z.boolean().default(false),
}).refine(q => !q.from || !q.to || Date.parse(q.from) < Date.parse(q.to), 'from must be before to');
type Change = { status: string; path: string; previousPath?: string };
function names(raw: string): Change[] {
  const fields = raw.split('\0'); const result: Change[] = [];
  for (let i = 0; i < fields.length - 1;) {
    const status = fields[i++]!; const path = fields[i++]!;
    result.push({ status, path }); // --no-renames: rename is delete + add.
  }
  return result;
}
function status(raw: string): Change[] {
  const fields = raw.split('\0'); const result: Change[] = [];
  for (let i = 0; i < fields.length - 1; i++) {
    const entry = fields[i]!; const code = entry.slice(0, 2);
    result.push({ status: code, path: entry.slice(3), ...(/[RC]/.test(code) ? { previousPath: fields[++i]! } : {}) });
  }
  return result;
}
export async function extractGitActivity(repository: Repository, input: unknown = {}) {
  const query = gitQuerySchema.parse(input);
  await validateRepository(repository.root);
  const started = Date.now(); const diagnostics: string[] = [];
  const run = (args: string[]) => {
    const remaining = 30_000 - (Date.now() - started);
    if (remaining <= 0) throw new Error('git_query_timeout');
    return git(repository.root, args, remaining);
  };
  const commits: { hash: string; timestamp: string; subject: string; changes?: Change[]; patch?: string }[] = [];
  let head: string | null = null;
  let workingTree: { observedAt: string; changedAt: null; changes: Change[]; stagedPatch?: string; unstagedPatch?: string } | null = null;
  let hasMore = false;
  let returnedBytes = 0;
  const bounded = (value: string) => {
    returnedBytes += Buffer.byteLength(value);
    if (returnedBytes > 4 * 1024 * 1024) throw new Error('git_total_output_limit');
    return value;
  };
  try {
    // An unborn HEAD produces no revision; other command failures remain diagnostics.
    const refs = await run(['rev-parse', '--revs-only', 'HEAD']);
    head = refs.trim() || null;
    if (head) {
      const args = ['log', '--no-merges', '--no-show-signature', '-z', '--format=%H%x00%cI%x00%s', `--max-count=${query.limit + 1}`];
      if (query.from) args.push(`--since-as-filter=${new Date(Math.ceil(Date.parse(query.from) / 1000) * 1000).toISOString()}`);
      if (query.to) args.push(`--until=${new Date(Math.ceil(Date.parse(query.to) / 1000) * 1000 - 1000).toISOString()}`);
      args.push(head, '--');
      const fields = bounded(await run(args)).split('\0');
      for (let i = 0; i + 2 < fields.length; i += 3) {
        const hash = fields[i]!; const timestamp = new Date(fields[i + 1]!).toISOString();
        if (query.from && Date.parse(timestamp) < Date.parse(query.from) || query.to && Date.parse(timestamp) >= Date.parse(query.to)) continue;
        if (commits.length === query.limit) { hasMore = true; break; }
        commits.push({ hash, timestamp, subject: fields[i + 2]! });
      }
      for (const commit of commits) {
        commit.changes = names(bounded(await run(['diff-tree', '--root', '--no-commit-id', '-r', '--no-renames', '--no-ext-diff', '--no-textconv', '--name-status', '-z', commit.hash, '--'])));
        if (query.includePatch) commit.patch = bounded(await run(['show', '--format=', '--no-show-signature', '--no-ext-diff', '--no-textconv', '--no-renames', '--submodule=short', commit.hash, '--']));
      }
    }
    if (hasMore) diagnostics.push('commit_limit');
    if (query.includeWorkingTree) {
      const changes = status(bounded(await run(['status', '--porcelain=v1', '-z', '--untracked-files=no', '--ignore-submodules=all'])));
      workingTree = { observedAt: new Date().toISOString(), changedAt: null, changes };
      if (query.includePatch) {
        workingTree.stagedPatch = bounded(await run(['diff', '--cached', '--no-ext-diff', '--no-textconv', '--no-renames', '--ignore-submodules=all', '--']));
        workingTree.unstagedPatch = bounded(await run(['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--ignore-submodules=all', '--']));
      }
    }
    if (head && (await run(['rev-parse', '--revs-only', 'HEAD'])).trim() !== head) diagnostics.push('head_changed_during_query');
    if (head && (await run(['rev-parse', '--is-shallow-repository'])).trim() === 'true') diagnostics.push('shallow_history');
  } catch (e) { diagnostics.push(e instanceof Error ? e.message : 'git_failed'); }
  return { repository: repository.name, root: repository.root, head, scope: 'HEAD reachable non-merge commits',
    range: { from: query.from ?? null, to: query.to ?? null }, commits, workingTree,
    hasMore, incomplete: diagnostics.length > 0, diagnostics };
}
