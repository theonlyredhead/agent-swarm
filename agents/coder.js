import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { promptJson } from '../tools/claude.js';
import { readManifest, writeManifest } from '../orchestrator/index.js';
import { commitAll } from '../tools/git.js';
import { log } from '../tools/log.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export async function code(workspace) {
  const manifest = readManifest(workspace);
  const { relevant_files, root_cause_summary, test_command } = manifest.navigator_output;

  await log(workspace, `🔧 Coder: applying fix to ${relevant_files.map(f => `\`${f}\``).join(', ')}...`);

  // Read relevant file contents
  const fileContents = relevant_files.map(relPath => {
    const absPath = path.join(workspace, relPath);
    const content = fs.existsSync(absPath) ? fs.readFileSync(absPath, 'utf8') : '(file not found)';
    return `=== ${relPath} ===\n${content}`;
  }).join('\n\n');

  const result = await promptJson({
    systemFile: path.join(__dirname, '../prompts/coder.md'),
    cacheUserPrefix: `Files:\n${fileContents}`,
    userMessage: `Task: ${manifest.task_id}\nRoot cause: ${root_cause_summary}`,
    model: 'claude-sonnet-4-6',
    maxTokens: 16000,
  });

  // Apply the fix
  for (const { path: filePath, new_content } of result.files) {
    const absPath = path.join(workspace, filePath);
    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    fs.writeFileSync(absPath, new_content, 'utf8');
  }

  const commit = commitAll(workspace, `fix(uat): ${manifest.task_id} - ${result.summary}`);

  writeManifest(workspace, {
    coder_output: {
      files_changed: result.files.map(f => f.path),
      summary: result.summary,
      commit_sha: commit.output,
    },
  });

  await log(workspace,
    `🔧 Coder done.\n` +
    `**Files changed:** ${result.files.map(f => `\`${f.path}\``).join(', ')}\n` +
    `**Summary:** ${result.summary}`);
}
