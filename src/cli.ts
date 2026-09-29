import { discoverRepositories } from './discovery.js';
import { extractGitActivity } from './git.js';
import { addRepository, selectRepository } from './config.js';
import { parseArgs } from 'node:util';
import { LocalSessionAdapter } from './extractor.js';
import { adapterCatalog } from './adapters.js';
import { addEnvironment, agentSchema, configPath, expandRoot, loadConfig, selectEnvironment } from './config.js';

const help = `trace — extract local agent sessions from a selected environment

trace agents
trace setup --environment NAME --agent AGENT --root PATH [--replace]
trace discover-git --root PATH [--register] [--max-depth N] [--max-entries N] [--max-repositories N]
trace setup-git --repository NAME --root PATH [--replace]
trace git-activity --repository NAME [--from ISO --to ISO --limit N --include-working-tree --include-patch]
trace environments
trace sessions --environment NAME [options]
trace extract --environment NAME [options]

Run through: npm run trace -- <command> [options]

  --config PATH        Config file (or TRACE_CONFIG; default ~/.config/trace/config.json)
  --agent AGENT        codex | claude-code | antigravity
  --root PATH          Explicit session/repository root, or discovery search root
  --environment NAME   Registered environment; required for every extraction
  --from ISO           Inclusive timestamp with timezone
  --to ISO             Exclusive timestamp with timezone
  --session ID         Select one session
  --include-text       Include message text (up to 4,000 chars per event)
  --limit N            Events: 1..1000 (default 100); Git commits: 1..100 (default 20)
  --offset N           Event offset (default 0)
  --scan-mode MODE     auto (native log mtimes) | full (imported/preserved mtimes)

Source files are read-only. No environment is scanned automatically.
Agent execution duration is unavailable when the format lacks turn boundaries.
Exit: 0 complete, 1 invalid request, 2 incomplete extraction (inspect diagnostics).
`;

try {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    register: { type: 'boolean' }, 'max-depth': { type: 'string' }, 'max-entries': { type: 'string' }, 'max-repositories': { type: 'string' },
    repository: { type: 'string' }, 'include-patch': { type: 'boolean' }, 'include-working-tree': { type: 'boolean' },
    config: { type: 'string' }, environment: { type: 'string' }, agent: { type: 'string' }, replace: { type: 'boolean' },
    root: { type: 'string' }, from: { type: 'string' }, to: { type: 'string' }, session: { type: 'string' },
    'include-text': { type: 'boolean' }, limit: { type: 'string' }, offset: { type: 'string' }, help: { type: 'boolean' },
    'scan-mode': { type: 'string' },
  } });
  const command = positionals[0];
  const path = values.config ? expandRoot(values.config) : configPath();
  if (values.help || !command) console.log(help);
  else {
    if (positionals.length > 1) throw new Error('Expected one command. Use --help.');
    if (command === 'agents') console.log(JSON.stringify(adapterCatalog, null, 2));
    else if (command === 'discover-git') {
      if (!values.root) throw new Error('discover-git requires an explicit --root PATH.');
      if (values.replace || values.repository || values.agent || values.environment) throw new Error('discover-git assigns new names and never replaces registrations.');
      const result = await discoverRepositories({ root: values.root, config: path, register: values.register,
        maxDepth: values['max-depth'] === undefined ? undefined : Number(values['max-depth']),
        maxEntries: values['max-entries'] === undefined ? undefined : Number(values['max-entries']),
        maxRepositories: values['max-repositories'] === undefined ? undefined : Number(values['max-repositories']),
      });
      console.log(JSON.stringify(result, null, 2));
      if (result.incomplete) process.exitCode = 2;
    } else if (command === 'setup-git') {
      if (!values.repository || !values.root) throw new Error('setup-git requires --repository and --root.');
      console.log(JSON.stringify({ config: path, repository: await addRepository({ name: values.repository, root: expandRoot(values.root) }, path, values.replace) }, null, 2));
    } else if (command === 'git-activity') {
      if (values.root || values.replace || values.agent) throw new Error('Use setup-git to register a repository first.');
      const result = await extractGitActivity(selectRepository(await loadConfig(path), values.repository), { from: values.from, to: values.to, limit: values.limit === undefined ? undefined : Number(values.limit), includePatch: values['include-patch'], includeWorkingTree: values['include-working-tree'] });
      console.log(JSON.stringify(result, null, 2));
      if (result.incomplete) process.exitCode = 2;
    } else if (command === 'setup') {
      if (!values.environment || !values.agent || !values.root) throw new Error('setup requires --environment, --agent, and --root.');
      const agent = agentSchema.safeParse(values.agent);
      if (!agent.success) throw new Error('Unknown agent. Run agents for supported formats.');
      const environment = await addEnvironment({ name: values.environment, agent: agent.data, root: expandRoot(values.root) }, path, values.replace);
      console.log(JSON.stringify({ config: path, environment }, null, 2));
    } else if (command === 'environments') console.log(JSON.stringify(await loadConfig(path), null, 2));
    else if (command === 'sessions' || command === 'extract') {
      if (values.root || values.agent || values.replace) throw new Error('Use setup to configure an environment; extraction only accepts registered environments.');
      const environment = selectEnvironment(await loadConfig(path), values.environment);
      const scanMode = values['scan-mode'];
      if (scanMode !== undefined && scanMode !== 'auto' && scanMode !== 'full') throw new Error('scan-mode must be auto or full.');
      const result = await new LocalSessionAdapter(environment).extract({
        scanMode,
        from: values.from, to: values.to, sessionId: values.session,
        includeText: command === 'extract' && values['include-text'],
        limit: values.limit === undefined ? undefined : Number(values.limit), offset: values.offset === undefined ? undefined : Number(values.offset),
      });
      console.log(JSON.stringify(command === 'sessions' ? { ...result, events: undefined, nextOffset: undefined } : result, null, 2));
      if (result.incomplete) process.exitCode = 2;
    } else throw new Error('Unknown command. Use --help.');
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Trace failed.');
  process.exitCode = 1;
}
