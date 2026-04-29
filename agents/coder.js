import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { promptJson } from '../tools/claude.js';
import { readManifest, writeManifest } from '../orchestrator/index.js';
import { commitAll } from '../tools/git.js';
import { log } from '../tools/log.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function readFile(workspace, relPath, charLimit = 0) {
  const abs = path.join(workspace, relPath);
  if (!fs.existsSync(abs)) return '(file not found)';
  const content = fs.readFileSync(abs, 'utf8');
  return charLimit && content.length > charLimit
    ? content.slice(0, charLimit) + '\n\n[... truncated ...]'
    : content;
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
      ? `Target ${v.tcCode}: ✅ PASSES — but regressions introduced`
      : `Target ${v.tcCode}: ❌ STILL FAILING`);
  }

  if (v.regressions?.length) {
    lines.push(
      `\n**Regressions you introduced** (were passing before your fix, now broken):`,
      v.regressions.map(id => `  - ${id}`).join('\n'),
      `\nFor each regression: find it in the UAT scenarios, trace what input it sends, trace`,
      `your modified code for that input, and understand why it broke. Fix that before returning.`
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

  // Full source files — no truncation, coder needs every line
  const fileContents = relevant_files.map(relPath =>
    `=== ${relPath} (EDIT THIS) ===\n${readFile(workspace, relPath)}`
  ).join('\n\n');

  // UAT scenarios — no truncation, coder must verify against every scenario
  const contextContents = (context_files ?? []).map(relPath =>
    `=== ${relPath} (READ ONLY — verify your fix against every scenario here) ===\n${readFile(workspace, relPath)}`
  ).join('\n\n');

  const cachePrefix = [
    `Files to edit:\n${fileContents}`,
    contextContents ? `Reference context:\n${contextContents}` : '',
  ].filter(Boolean).join('\n\n');

  // If navigator produced a suggested fix, give it verbatim to the coder
  const fixInstruction = suggested_fix ? [
    `\n\nSuggested fix (implement this exactly):`,
    `File: ${suggested_fix.file}`,
    `What: ${suggested_fix.what}`,
    `\nFind and replace this exact code:\n\`\`\`\n${suggested_fix.current_code}\n\`\`\``,
    `\nWith this:\n\`\`\`\n${suggested_fix.replacement_code}\n\`\`\``,
    suggested_fix.handles_cases?.length
      ? `\nThis fix is designed to handle:\n${suggested_fix.handles_cases.map(c => `  - ${c}`).join('\n')}`
      : '',
  ].filter(Boolean).join('\n') : '';

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

  // Log scenario_coverage so we can see the coder's self-verification in ClickUp
  const coverageLog = result.scenario_coverage
    ? Object.entries(result.scenario_coverage).map(([k, v]) => `  **${k}:** ${v}`).join('\n')
    : '(none)';

  writeManifest(workspace, {
    coder_output: {
      files_changed: result.files.map(f => f.path),
      summary: result.summary,
      scenario_coverage: result.scenario_coverage ?? null,
      commit_sha: commit.output,
    },
  });

  await log(workspace,
    `🔧 Coder done.\n` +
    `**Files changed:** ${result.files.map(f => `\`${f.path}\``).join(', ')}\n` +
    `**Summary:** ${result.summary}\n` +
    `**Scenario coverage:**\n${coverageLog}`);
}
