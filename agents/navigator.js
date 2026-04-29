import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { promptJson } from '../tools/claude.js';
import { readManifest, writeManifest } from '../orchestrator/index.js';
import { exec } from '../tools/shell.js';
import { log } from '../tools/log.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Primary source file patterns — most likely to contain business logic bugs
const SOURCE_PATTERNS = [
  /lambda[-_].+\.js$/,
  /handler\.js$/,
  /\/src\/.+\.js$/,
  /\/routes?\/.+\.js$/,
  /\/controllers?\/.+\.js$/,
  /\/api\/.+\.js$/,
  /\/functions?\/.+\.js$/,
  /\/middleware\/.+\.js$/,
  /\/services?\/.+\.js$/,
  /\/validators?\/.+\.js$/,
  /\/lib\/.+\.js$/,
];

// UAT scenario files — ground truth for what tests expect
const UAT_SCENARIO_CANDIDATES = [
  'uat-agent/scenarios.js',
  'uat-agent/scenarios.json',
  'uat-agent/cases.js',
  'uat-agent/cases.json',
  'uat-agent/index.js',
];

function extractPaths(tree) {
  return tree.split('\n')
    .map(l => l.replace(/^\.\//, '').trim())
    .filter(l => l && !l.includes('node_modules') && !l.includes('/.git/') && !l.includes('/dist/') && !l.includes('/build/'));
}

function safeRead(absPath, charLimit = 25000) {
  try {
    const content = fs.readFileSync(absPath, 'utf8');
    return content.length > charLimit ? content.slice(0, charLimit) + '\n\n[... file truncated at char limit ...]' : content;
  } catch { return null; }
}

// Read a source file and resolve its local imports one level deep.
// This catches bugs in validators, shared utils, and middleware that the main file delegates to.
function readWithImports(workspace, relPath, alreadyRead) {
  const abs = path.join(workspace, relPath);
  const content = safeRead(abs);
  if (!content) return [];

  alreadyRead.add(relPath);
  const results = [{ relPath, content }];

  // Extract local imports: `from './foo'`, `require('./foo')`
  const importRegex = /(?:from\s+|require\()['"](\.[^'"]+)['"]/g;
  let match;
  while ((match = importRegex.exec(content)) !== null) {
    const importSpec = match[1];
    const dir = path.dirname(abs);
    const candidates = [
      path.join(dir, importSpec),
      path.join(dir, importSpec + '.js'),
      path.join(dir, importSpec, 'index.js'),
    ];
    for (const candidate of candidates) {
      if (!fs.existsSync(candidate)) continue;
      const rel = path.relative(workspace, candidate);
      if (alreadyRead.has(rel) || rel.includes('node_modules')) break;
      const importContent = safeRead(candidate, 15000);
      if (importContent) {
        alreadyRead.add(rel);
        results.push({ relPath: rel, content: importContent });
      }
      break;
    }
  }

  return results;
}

function selectSourceFiles(workspace, tree, entryPoints) {
  // Prefer explicitly declared entry points
  if (entryPoints?.length) return entryPoints;

  // Fall back to pattern-matched files from tree, sorted by specificity
  const all = extractPaths(tree).filter(p =>
    p.endsWith('.js') &&
    !p.includes('.test.') && !p.includes('.spec.') &&
    !p.includes('node_modules') && !p.includes('uat-agent')
  );

  // Score: more specific patterns rank higher
  const scored = all.map(p => {
    let score = 0;
    if (/lambda[-_].+\.js$/.test(p)) score += 10;
    if (/\/src\//.test(p)) score += 5;
    if (/handler|route|controller|service|validator/.test(p)) score += 3;
    return { p, score };
  });

  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, 8)
    .map(x => x.p);
}

function readUatScenarios(workspace) {
  const found = UAT_SCENARIO_CANDIDATES.find(f => fs.existsSync(path.join(workspace, f)));
  if (!found) return null;
  const content = safeRead(path.join(workspace, found), 40000); // no aggressive truncation — tests are ground truth
  return content ? { path: found, content } : null;
}

export async function navigate(workspace, failureContext) {
  await log(workspace, `🗺️ Navigator: reading source code...`);

  const swarmConfig = (() => {
    const p = path.join(workspace, 'swarm.config.json');
    return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null;
  })();

  const tree = exec(
    'find . -not -path "*/node_modules/*" -not -path "*/.git/*" -not -path "*/dist/*" -not -path "*/build/*" -maxdepth 5 -type f',
    { cwd: workspace }
  ).output;

  const packageJson = (() => {
    const p = path.join(workspace, 'package.json');
    return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
  })();

  const uatScenarios = readUatScenarios(workspace);

  // Read source files including local imports — one level deep
  const selectedFiles = selectSourceFiles(workspace, tree, swarmConfig?.entry_points);
  const alreadyRead = new Set();
  const allSourceFiles = selectedFiles.flatMap(f => readWithImports(workspace, f, alreadyRead));

  const sourceBlock = allSourceFiles.length
    ? allSourceFiles.map(({ relPath, content }) => `=== ${relPath} ===\n${content}`).join('\n\n')
    : `(no source files found — file tree below)\n${tree}`;

  const uatBlock = uatScenarios
    ? `=== UAT SCENARIOS: ${uatScenarios.path} (ground truth — read every scenario) ===\n${uatScenarios.content}`
    : '';

  await log(workspace, `🗺️ Navigator: diagnosing with Opus... (${allSourceFiles.length} files, ${uatScenarios ? 'UAT loaded' : 'no UAT'})`);

  // Opus for diagnosis — this is the critical thinking step, not the place to save money
  const result = await promptJson({
    systemFile: path.join(__dirname, '../prompts/navigator.md'),
    cacheUserPrefix: [sourceBlock, uatBlock].filter(Boolean).join('\n\n'),
    userMessage: [
      `Failure to fix:\n${failureContext}`,
      swarmConfig ? `swarm.config.json:\n${JSON.stringify(swarmConfig, null, 2)}` : '',
      `package.json:\n${packageJson}`,
    ].filter(Boolean).join('\n\n'),
    model: 'claude-opus-4-7',
    maxTokens: 16000,
  });

  // swarm.config.json overrides
  if (swarmConfig?.test_command) result.test_command = swarmConfig.test_command;
  if (swarmConfig?.entry_points) result.entry_points = swarmConfig.entry_points;

  // Ensure UAT file is always in context_files
  if (uatScenarios) {
    result.context_files = [...new Set([...(result.context_files ?? []), uatScenarios.path])];
  }

  writeManifest(workspace, { navigator_output: result });

  const fixSummary = result.suggested_fix
    ? `**Suggested fix:** ${result.suggested_fix.what}\n**Handles:** ${(result.suggested_fix.handles_cases ?? []).join(', ')}`
    : '⚠️  No suggested fix produced — coder will reason from root cause';

  await log(workspace,
    `🗺️ Navigator done.\n` +
    `**Files:** ${(result.relevant_files ?? []).map(f => `\`${f}\``).join(', ')}\n` +
    `**Root cause:** ${result.root_cause_summary}\n` +
    `${fixSummary}\n` +
    `**Confidence:** ${Math.round((result.confidence ?? 0) * 100)}%`);
}
