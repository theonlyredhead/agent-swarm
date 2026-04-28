import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { promptJson } from '../tools/claude.js';
import { readManifest, writeManifest } from '../orchestrator/index.js';
import { exec } from '../tools/shell.js';
import { log } from '../tools/log.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// UAT scenario files — read as context so the coder understands what inputs tests send
const UAT_SCENARIO_CANDIDATES = [
  'uat-agent/scenarios.js',
  'uat-agent/scenarios.json',
  'uat-agent/scenarios.ts',
  'uat-agent/cases.js',
  'uat-agent/cases.json',
  'uat-agent/index.js',
];

function readUatContext(workspace) {
  const found = UAT_SCENARIO_CANDIDATES.find(f => fs.existsSync(path.join(workspace, f)));
  if (!found) return null;
  try {
    const content = fs.readFileSync(path.join(workspace, found), 'utf8');
    return { path: found, content: content.slice(0, 6000) };
  } catch {
    return null;
  }
}

export async function navigate(workspace, failureContext) {
  await log(workspace, `🗺️ Navigator: mapping repo structure...`);

  // Check for swarm.config.json
  let swarmConfig = null;
  const configPath = path.join(workspace, 'swarm.config.json');
  if (fs.existsSync(configPath)) {
    swarmConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  }

  // Get file tree (max depth 4, exclude noise)
  const tree = exec(
    `find . -not -path '*/node_modules/*' -not -path '*/.git/*' -not -path '*/dist/*' -not -path '*/build/*' -maxdepth 4`,
    { cwd: workspace }
  ).output;

  // Read package.json if present
  let packageJson = '';
  const pkgPath = path.join(workspace, 'package.json');
  if (fs.existsSync(pkgPath)) packageJson = fs.readFileSync(pkgPath, 'utf8');

  // Read UAT scenario file — gives the AI a concrete picture of what test inputs look like
  const uatContext = readUatContext(workspace);

  const userMessage = [
    `Failure context: ${failureContext}`,
    swarmConfig ? `swarm.config.json: ${JSON.stringify(swarmConfig)}` : '',
    `package.json: ${packageJson}`,
    uatContext ? `UAT scenario file (${uatContext.path}) — understand what inputs the tests send:\n${uatContext.content}` : '',
    `File tree:\n${tree}`,
  ].filter(Boolean).join('\n\n');

  const result = await promptJson({
    systemFile: path.join(__dirname, '../prompts/navigator.md'),
    userMessage,
    model: 'claude-sonnet-4-6',
  });

  // Use swarm.config.json overrides if present
  if (swarmConfig?.test_command) result.test_command = swarmConfig.test_command;
  if (swarmConfig?.entry_points) result.entry_points = swarmConfig.entry_points;

  // Attach UAT context file path so the coder can read the full test file
  if (uatContext && !result.context_files?.includes(uatContext.path)) {
    result.context_files = [...(result.context_files ?? []), uatContext.path];
  }

  writeManifest(workspace, { navigator_output: result });
  await log(workspace,
    `🗺️ Navigator done.\n` +
    `**Relevant files:** ${(result.relevant_files ?? []).map(f => `\`${f}\``).join(', ')}\n` +
    `**Context files:** ${(result.context_files ?? []).map(f => `\`${f}\``).join(', ') || 'none'}\n` +
    `**Root cause:** ${result.root_cause_summary}\n` +
    `**Test command:** \`${result.test_command}\`\n` +
    `**Confidence:** ${Math.round((result.confidence ?? 0) * 100)}%`);
}
