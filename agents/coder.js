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
    '\n\n## Previous fix attempt FAILED — diagnose before rewriting',
    `Pass rate: ${v.passRate ?? 'unknown'}% (baseline was ${v.baselinePassRate ?? 'unknown'}%)`,
  ];

  if (v.tcCode) {
    lines.push(v.tcPassed
      ? `Target ${v.tcCode}: ✅ PASSES — but regressions introduced (see below)`
      : `Target ${v.tcCode}: ❌ STILL FAILING`);
  }

  if (v.regressions?.length) {
    lines.push(
      `\n**Regressions you introduced** (passing before, now broken):`,
      v.regressions.map(id => `  - ${id}`).join('\n'),
      `\nThese scenarios were working before your fix. Read the UAT context file to understand`,
      `what inputs they send and what responses they expect, then understand WHY your change`,
      `broke their code path before writing a new fix.`
    );
  }

  if (v.improvements?.length) {
    lines.push(
      `\n**Improvements** (now passing):`,
      v.improvements.map(id => `  - ${id}`).join('\n')
    );
  }

  const testOutput = (v.errors || v.output || '').trim().slice(0, 3000);
  if (testOutput) lines.push(`\n**Test output:**\n\`\`\`\n${testOutput}\n\`\`\``);

  return lines.join('\n');
}

export async function code(workspace) {
  const manifest = readManifest(workspace);
  const { relevant_files, context_files, root_cause_summary, suggested_fix } = manifest.navigator_output;

  await log(workspace, `🔧 Coder: applying fix to ${relevant_files.map(f => `\`${f}\``).join(', ')}...`);

  // Files to edit — full content
  const fileContents = relevant_files.map(relPath =>
    `=== ${relPath} (EDIT THIS) ===\n${readFile(workspace, relPath)}`
  ).join('\n\n');

  // Read-only context (UAT scenarios, shared validators)
  const contextContents = (context_files ?? []).map(relPath =>
    `=== ${relPath} (READ ONLY) ===\n${readFile(workspace, relPath).slice(0, 5000)}`
  ).join('\n\n');

  const cachePrefix = [
    `Files to edit:\n${fileContents}`,
    contextContents ? `Reference context:\n${contextContents}` : '',
  ].filter(Boolean).join('\n\n');

  const fixInstruction = suggested_fix
    ? `\n\nSuggested fix:\n- File: ${suggested_fix.file}\n- What: ${suggested_fix.what}\n- Replace this exact code:\n\`\`\`\n${suggested_fix.current_code}\n\`\`\`\n- With this:\n\`\`\`\n${suggested_fix.replacement_code}\n\`\`\``
    : '';

  const retryContext = buildRetryContext(manifest);

  const result = await promptJson({
    systemFile: path.join(__dirname, '../prompts/coder.md'),
    cacheUserPrefix: cachePrefix,
    userMessage: `Root cause: ${root_cause_summary}${fixInstruction}${retryContext}`,
    model: 'claude-sonnet-4-6',
    maxTokens: 16000,
  });

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
