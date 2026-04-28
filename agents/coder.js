import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { promptJson } from '../tools/claude.js';
import { readManifest, writeManifest } from '../orchestrator/index.js';
import { commitAll } from '../tools/git.js';
import { log } from '../tools/log.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function readFile(workspace, relPath) {
  const abs = path.join(workspace, relPath);
  return fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : '(file not found)';
}

function buildRetryContext(manifest) {
  const v = manifest.verifier_output;
  if (!v) return '';

  const lines = [
    `\n\n## Previous fix attempt FAILED — read this carefully before writing a new fix`,
    `Pass rate: ${v.passRate ?? 'unknown'}% (baseline was ${v.baselinePassRate ?? v.passRate ?? 'unknown'}%)`,
  ];

  if (v.tcCode) {
    lines.push(v.tcPassed
      ? `Target ${v.tcCode}: ✅ PASSES — but you introduced regressions (see below)`
      : `Target ${v.tcCode}: ❌ STILL FAILING`);
  }

  if (v.regressions?.length) {
    lines.push(`\n**Regressions you introduced** (were passing before, now broken by your fix):`);
    lines.push(v.regressions.map(id => `  - ${id}`).join('\n'));
    lines.push(`\nThese were working correctly before you touched the code. Your fix broke them.`);
    lines.push(`Read the UAT scenario file and the source file carefully — understand what inputs`);
    lines.push(`these tests send and why your change broke their path before writing a new fix.`);
  }

  if (v.improvements?.length) {
    lines.push(`\n**Improvements** (now passing that weren't before):`);
    lines.push(v.improvements.map(id => `  - ${id}`).join('\n'));
  }

  const testOutput = (v.errors || v.output || '').trim().slice(0, 3000);
  if (testOutput) {
    lines.push(`\n**Test output:**\n\`\`\`\n${testOutput}\n\`\`\``);
  }

  return lines.join('\n');
}

export async function code(workspace) {
  const manifest = readManifest(workspace);
  const { relevant_files, context_files, root_cause_summary } = manifest.navigator_output;

  await log(workspace, `🔧 Coder: applying fix to ${relevant_files.map(f => `\`${f}\``).join(', ')}...`);

  // Files to edit — full content
  const fileContents = relevant_files.map(relPath =>
    `=== ${relPath} (EDIT THIS) ===\n${readFile(workspace, relPath)}`
  ).join('\n\n');

  // Context files — read for understanding, do not edit
  const contextContents = (context_files ?? []).map(relPath =>
    `=== ${relPath} (READ ONLY — understand what inputs tests send) ===\n${readFile(workspace, relPath).slice(0, 4000)}`
  ).join('\n\n');

  const cachePrefix = [
    `Files to edit:\n${fileContents}`,
    contextContents ? `Reference context (do not edit):\n${contextContents}` : '',
  ].filter(Boolean).join('\n\n');

  const retryContext = buildRetryContext(manifest);

  const result = await promptJson({
    systemFile: path.join(__dirname, '../prompts/coder.md'),
    cacheUserPrefix: cachePrefix,
    userMessage: `Task: ${manifest.task_id}\nRoot cause: ${root_cause_summary}${retryContext}`,
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
