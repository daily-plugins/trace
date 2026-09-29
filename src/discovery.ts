import { lstat, opendir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { expandRoot, planDiscoveredRepositories, configPath } from './config.js';
import { validateRepository } from './git.js';

const optionsSchema = z.object({
  root: z.string().min(1), maxDepth: z.number().int().min(0).max(30).default(8),
  maxEntries: z.number().int().min(1).max(100_000).default(20_000),
  maxRepositories: z.number().int().min(1).max(1000).default(100),
  register: z.boolean().default(false), config: z.string().optional(),
});
const excluded = new Set(['.git', 'node_modules', '.cache', '.Trash', 'Library', '.venv', 'venv', '__pycache__', 'dist', 'build', 'vendor']);

export async function discoverRepositories(input: unknown) {
  const options = optionsSchema.parse(input);
  let root: string;
  try {
    root = await realpath(expandRoot(options.root));
    if (!(await lstat(root)).isDirectory()) throw new Error();
  } catch { throw new Error('Discovery root must be an accessible existing directory.'); }
  const roots: string[] = []; const diagnostics: { code: string; path: string }[] = [];
  const started = Date.now(); let entries = 0; let directories = 0; let stopped = false;
  const report = (code: string, path: string) => { diagnostics.push({ code, path }); };
  const queue: { path: string; depth: number }[] = [{ path: root, depth: 0 }];
  for (let cursor = 0; cursor < queue.length && !stopped; cursor++) {
    const current = queue[cursor]!;
    if (Date.now() - started >= 30_000) { report('discovery_timeout', current.path); break; }
    // Re-check directory type to avoid following ordinary symlinks encountered in traversal.
    try { if (!(await lstat(current.path)).isDirectory()) { report('directory_changed', current.path); continue; } }
    catch { report('unreadable_directory', current.path); continue; }
    directories++;
    try {
      const marker = await lstat(join(current.path, '.git'));
      if (marker.isSymbolicLink()) report('symlink_git_marker', current.path);
      else if (marker.isDirectory() || marker.isFile()) {
        try {
          const canonical = await validateRepository(current.path);
          if (roots.length >= options.maxRepositories) { report('repository_limit', current.path); stopped = true; break; }
          roots.push(canonical);
        } catch { report('invalid_git_repository', current.path); }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') report('unreadable_git_marker', current.path);
    }
    try {
      const directory = await opendir(current.path);
      for await (const entry of directory) {
        if (++entries > options.maxEntries) { report('entry_limit', current.path); stopped = true; break; }
        if (Date.now() - started >= 30_000) { report('discovery_timeout', current.path); stopped = true; break; }
        if (!entry.isDirectory() || excluded.has(entry.name)) continue;
        if (current.depth >= options.maxDepth) { report('depth_limit', join(current.path, entry.name)); continue; }
        queue.push({ path: join(current.path, entry.name), depth: current.depth + 1 });
      }
    } catch { report('unreadable_directory', current.path); }
  }
  const plan = await planDiscoveredRepositories(roots, options.config ?? configPath(), options.register);
  return { root, mode: options.register ? 'register' : 'preview',
    repositories: [...plan.added.map(r => ({ ...r, status: options.register ? 'registered' : 'new' })), ...plan.existing.map(r => ({ ...r, status: 'existing' }))],
    discovered: roots.length, added: options.register ? plan.added.length : 0,
    scan: { directories, entries: Math.min(entries, options.maxEntries), maxDepth: options.maxDepth, excludedDirectories: [...excluded] },
    incomplete: diagnostics.length > 0, diagnostics };
}
