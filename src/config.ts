import { mkdir, open, readFile, realpath, rename, stat, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { validateRepository } from './git.js';

export const agentSchema = z.enum(['codex', 'claude-code', 'antigravity']);
export type Agent = z.infer<typeof agentSchema>;
export const environmentSchema = z.object({
  name: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/),
  agent: agentSchema,
  root: z.string().min(1).refine(isAbsolute, 'root must be absolute'),
}).strict();
export type Environment = z.infer<typeof environmentSchema>;
export const repositorySchema = environmentSchema.omit({ agent: true });
export type Repository = z.infer<typeof repositorySchema>;
const configSchema = z.object({
  version: z.literal(1), environments: z.array(environmentSchema), repositories: z.array(repositorySchema).optional(),
}).strict().refine(c => new Set(c.environments.map(e => e.name)).size === c.environments.length, 'Environment names must be unique').refine(c => new Set((c.repositories ?? []).map(r => r.name)).size === (c.repositories ?? []).length, 'Repository names must be unique');
export type Config = z.infer<typeof configSchema>;
export function configPath(): string {
  return resolve(process.env.TRACE_CONFIG ?? join(homedir(), '.config', 'trace', 'config.json'));
}
export function expandRoot(path: string): string {
  return resolve(path === '~' ? homedir() : path.startsWith('~/') ? join(homedir(), path.slice(2)) : path);
}
export async function loadConfig(path = configPath()): Promise<Config> {
  let raw: string;
  try { raw = await readFile(path, 'utf8'); }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, environments: [] };
    throw new Error('Cannot read Trace configuration.');
  }
  try { return configSchema.parse(JSON.parse(raw)); }
  catch { throw new Error('Invalid Trace configuration: expected version 1 and unique named environments with agent and absolute root.'); }
}
export function selectEnvironment(config: Config, name?: string): Environment {
  if (!name) throw new Error('Choose an environment explicitly using --environment NAME (MCP: environment).');
  const selected = config.environments.find(e => e.name === name);
  if (!selected) throw new Error(`Environment "${name}" is not configured. Run setup first.`);
  return selected;
}
export async function addEnvironment(input: Environment, path = configPath(), replace = false): Promise<Environment> {
  const env = environmentSchema.parse({ ...input, root: expandRoot(input.root) });
  try { env.root = await realpath(env.root); if (!(await stat(env.root)).isDirectory()) throw new Error(); }
  catch { throw new Error('The selected session root must be an accessible existing directory.'); }
  return saveRegistration(env, 'environments', path, replace);
}
export async function addRepository(input: Repository, path = configPath(), replace = false): Promise<Repository> {
  const repository = repositorySchema.parse({ ...input, root: expandRoot(input.root) });
  repository.root = await validateRepository(repository.root);
  return saveRegistration(repository, 'repositories', path, replace);
}
export function selectRepository(config: Config, name?: string): Repository {
  if (!name) throw new Error('Choose a repository explicitly using --repository NAME (MCP: repository).');
  const repository = config.repositories?.find(r => r.name === name);
  if (!repository) throw new Error('Repository is not configured. Run setup-git first.');
  return repository;
}
async function saveRegistration<T extends Repository>(env: T, kind: 'environments' | 'repositories', path: string, replace: boolean): Promise<T> {
  return updateConfig(path, config => {
    const entries: Repository[] = config[kind] ?? [];
    const exists = entries.some(e => e.name === env.name);
    if (exists && !replace) throw new Error('Registration already exists. Use --replace to update it.');
    const updated = [...entries.filter(e => e.name !== env.name), env];
    if (kind === 'environments') config.environments = updated as Environment[];
    else config.repositories = updated;
    return env;
  });
}
async function updateConfig<T>(path: string, update: (config: Config) => T | Promise<T>): Promise<T> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  // Exclusive setup lock prevents two concurrent registrations from losing updates.
  const lockPath = `${path}.lock`;
  let lock;
  try { lock = await open(lockPath, 'wx', 0o600); }
  catch { throw new Error('Configuration is locked by another setup. Retry after it finishes.'); }
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const config = await loadConfig(path);
    const result = await update(config);
    const file = await open(temporary, 'wx', 0o600);
    try { await file.writeFile(`${JSON.stringify(config, null, 2)}\n`); }
    finally { await file.close(); }
    await rename(temporary, path);
    return result;
  } finally {
    await unlink(temporary).catch(() => {});
    await lock.close(); await unlink(lockPath);
  }
}

// The caller supplies canonical roots validated by the bounded discovery pass.
export async function planDiscoveredRepositories(roots: string[], path = configPath(), register = false) {
  const plan = async (config: Config) => {
    const entries = [...(config.repositories ?? [])];
    const canonical = new Map<string, Repository>();
    for (const entry of entries) canonical.set(await realpath(entry.root).catch(() => entry.root), entry);
    const names = new Set(entries.map(e => e.name));
    const added: Repository[] = []; const existing: Repository[] = [];
    for (const root of [...new Set(roots)].sort()) {
      const prior = canonical.get(root);
      if (prior) { existing.push(prior); continue; }
      const base = basename(root).toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^[^a-z0-9]+/, '').slice(0, 54) || 'repository';
      let name = base; let suffix = 2;
      while (names.has(name)) name = `${base}-${suffix++}`;
      const entry = repositorySchema.parse({ name, root });
      names.add(name); canonical.set(root, entry); entries.push(entry); added.push(entry);
    }
    config.repositories = entries;
    return { added, existing };
  };
  return register ? updateConfig(path, plan) : plan(await loadConfig(path));
}
