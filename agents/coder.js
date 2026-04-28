import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { promptJson } from '../tools/claude.js';
import { readManifest, writeManifest } from '../orchestrator/index.js';
import { commitAll } from '../tools/git.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export async function code(workspace) {
  const manifest = readManifest(workspace);
  const { relevant_files, root_cause_summary, test_command } = manifest.navigator_output;

  console.log(`[coder] Writing fix for ${manifest.task_id}`);

  // Read relevant file contents
  const fileContents = relevant_files.map(relPath => {
    const absPath = path.join(workspace, relPath);
    const content = fs.existsSync(absPath) ? fs.readFileSync(absPath, 'utf8') : '(file not found)';
    return `=== ${relPath} ===\n${content}`;
  }).join('\n\n');

  const result = await promptJson({
    systemFile: path.join(__dirname, '../prompts/coder.md'),
    userMessage: `Task: ${manifest.task_id}\nRoot cause: ${root_cause_summary}\n\nFiles:\n${fileContents}`,
    model: 'claude-opus-4-7',
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

  console.log(`[coder] Fixed ${result.files.length} file(s): ${result.summary}`);
}
