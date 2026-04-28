import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { promptJson } from '../tools/claude.js';
import { readManifest, writeManifest } from '../orchestrator/index.js';
import { exec } from '../tools/shell.js';
import { log } from '../tools/log.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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

  const userMessage = [
    `Failure context: ${failureContext}`,
    swarmConfig ? `swarm.config.json: ${JSON.stringify(swarmConfig)}` : '',
    `package.json: ${packageJson}`,
    `File tree:\n${tree}`,
  ].filter(Boolean).join('\n\n');

  const result = await promptJson({
    systemFile: path.join(__dirname, '../prompts/navigator.md'),
    userMessage,
    model: 'claude-opus-4-7',
  });

  // Use swarm.config.json overrides if present
  if (swarmConfig?.test_command) result.test_command = swarmConfig.test_command;
  if (swarmConfig?.entry_points) result.entry_points = swarmConfig.entry_points;

  writeManifest(workspace, { navigator_output: result });
  await log(workspace,
    `🗺️ Navigator done.\n` +
    `**Relevant files:** ${(result.relevant_files ?? []).map(f => `\`${f}\``).join(', ')}\n` +
    `**Root cause:** ${result.root_cause_summary}\n` +
    `**Test command:** \`${result.test_command}\`\n` +
    `**Confidence:** ${Math.round((result.confidence ?? 0) * 100)}%`);
}
