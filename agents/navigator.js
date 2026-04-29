import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { promptJson } from '../tools/claude.js';
import { readManifest, writeManifest } from '../orchestrator/index.js';
import { exec } from '../tools/shell.js';
import { log } from '../tools/log.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Source file patterns likely to contain business logic bugs
const SOURCE_PATTERNS = [
  /lambda[-_].+\.js$/,
  /handler\.js$/,
  /\/src\/.+\.js$/,
  /\/routes?\/.+\.js$/,
  /\/controllers?\/.+\.js$/,
  /\/api\/.+\.js$/,
  /\/functions?\/.+\.js$/,
];

const UAT_SCENARIO_CANDIDATES = [
  'uat-agent/scenarios.js',
  'uat-agent/scenarios.json',
  'uat-agent/cases.js',
  'uat-agent/index.js',
];

function extractPaths(tree) {
  return tree.split('\n')
    .map(l => l.replace(/^\.\//, '').trim())
    .filter(l => l && !l.includes('node_modules') && !l.includes('.test.') && !l.includes('.spec.'));
}

// Pre-read source files so the navigator has actual code to analyse, not just filenames.
// Uses entry_points from swarm.config.json if present, otherwise pattern-matches likely files.
function readSourceFiles(workspace, tree, entryPoints) {
  const candidates = entryPoints?.length
    ? entryPoints
    : extractPaths(tree).filter(p => SOURCE_PATTERNS.some(re => re.test(p))).slice(0, 6);

  return candidates.map(relPath => {
    const abs = path.join(workspace, relPath);
    if (!fs.existsSync(abs)) return null;
    const content = fs.readFileSync(abs, 'utf8');
    if (content.length > 20000) return `=== ${relPath} ===\n${content.slice(0, 20000)}\n[...truncated]`;
    return `=== ${relPath} ===\n${content}`;
  }).filter(Boolean);
}

function readUatScenarios(workspace) {
  const found = UAT_SCENARIO_CANDIDATES.find(f => fs.existsSync(path.join(workspace, f)));
  if (!found) return null;
  try {
    const content = fs.readFileSync(path.join(workspace, found), 'utf8');
    return { path: found, content: content.slice(0, 8000) };
  } catch { return null; }
}

export async function navigate(workspace, failureContext) {
  await log(workspace, `🗺️ Navigator: mapping repo structure...`);

  const swarmConfig = (() => {
    const p = path.join(workspace, 'swarm.config.json');
    return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null;
  })();

  const tree = exec(
    'find . -not -path "*/node_modules/*" -not -path "*/.git/*" -not -path "*/dist/*" -not -path "*/build/*" -maxdepth 4',
    { cwd: workspace }
  ).output;

  const packageJson = (() => {
    const p = path.join(workspace, 'package.json');
    return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
  })();

  // Pre-read actual source files — navigator gets real code, not just filenames
  const sourceFiles = readSourceFiles(workspace, tree, swarmConfig?.entry_points);
  const uatScenarios = readUatScenarios(workspace);

  const cachePrefix = [
    sourceFiles.length ? `Source files:\n${sourceFiles.join('\n\n')}` : '',
    uatScenarios ? `UAT scenarios (${uatScenarios.path}):\n${uatScenarios.content}` : '',
  ].filter(Boolean).join('\n\n');

  const userMessage = [
    `Failure to fix:\n${failureContext}`,
    swarmConfig ? `swarm.config.json:\n${JSON.stringify(swarmConfig, null, 2)}` : '',
    `package.json:\n${packageJson}`,
    !sourceFiles.length ? `File tree:\n${tree}` : '',
  ].filter(Boolean).join('\n\n');

  const result = await promptJson({
    systemFile: path.join(__dirname, '../prompts/navigator.md'),
    cacheUserPrefix: cachePrefix,
    userMessage,
    model: 'claude-sonnet-4-6',
  });

  // swarm.config.json overrides
  if (swarmConfig?.test_command) result.test_command = swarmConfig.test_command;
  if (swarmConfig?.entry_points) result.entry_points = swarmConfig.entry_points;

  // Always attach UAT scenario file as context
  if (uatScenarios) {
    result.context_files = [...new Set([...(result.context_files ?? []), uatScenarios.path])];
  }

  writeManifest(workspace, { navigator_output: result });

  const fixPreview = result.suggested_fix
    ? `**Suggested fix:** ${result.suggested_fix.what}`
    : '(no suggested fix)';

  await log(workspace,
    `🗺️ Navigator done.\n` +
    `**Relevant files:** ${(result.relevant_files ?? []).map(f => `\`${f}\``).join(', ')}\n` +
    `**Root cause:** ${result.root_cause_summary}\n` +
    `${fixPreview}\n` +
    `**Confidence:** ${Math.round((result.confidence ?? 0) * 100)}%`);
}
