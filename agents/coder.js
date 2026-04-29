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

// Apply suggested_fix as a direct string replacement — no LLM involved.
// Returns true on success, false if current_code not found in file.
function applyDirectFix(workspace, suggested_fix) {
  const abs = path.join(workspace, suggested_fix.file);
  if (!fs.existsSync(abs)) return false;

  let content = fs.readFileSync(abs, 'utf8');

  // Normalise line endings for matching
  const norm = s => s.replace(/\r\n/g, '\n');
  const normContent = norm(content);
  const normCurrent = norm(suggested_fix.current_code);

  if (!normContent.includes(normCurrent)) return false;

  const updated = normContent.replace(normCurrent, norm(suggested_fix.replacement_code));
  fs.writeFileSync(abs, updated, 'utf8');
  return true;
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
      `\n**Regressions you introduced** (were passing before, now broken):`,
      v.regressions.map(id => `  - ${id}`).join('\n'),
      `\nFor each regression: find it in the UAT scenarios, trace what input it sends,`,
      `trace your modified code for that input, and understand why it broke.`,
      `Fix ONLY the failing TC — do not touch any other field or validation rule.`
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
  const { relevant_files, context_files, root_cause_summary, suggested_fix, confidence } = manifest.navigator_output;
  const isRetry = !!manifest.verifier_output;

  // ── Direct apply (first attempt, high confidence) ──────────────────────────
  // Skip the LLM entirely. Use the navigator's verbatim current_code →
  // replacement_code as a surgical string replacement. This avoids the risk
  // of an LLM rewriting a large file and introducing bugs.
  if (suggested_fix && confidence >= 0.9 && !isRetry) {
    await log(workspace, `🔧 Coder: applying direct fix to \`${suggested_fix.file}\` (navigator confidence ${Math.round(confidence * 100)}%)...`);

    const applied = applyDirectFix(workspace, suggested_fix);

    if (applied) {
      const commit = commitAll(workspace, `fix(uat): ${manifest.task_id} - ${suggested_fix.what}`);
      writeManifest(workspace, {
        coder_output: {
          files_changed: [suggested_fix.file],
          summary: suggested_fix.what,
          commit_sha: commit.output,
          direct_apply: true,
        },
      });
      await log(workspace,
        `🔧 Direct fix applied.\n` +
        `**File:** \`${suggested_fix.file}\`\n` +
        `**Change:** ${suggested_fix.what}\n` +
        `**Handles:** ${(suggested_fix.handles_cases ?? []).join(' | ')}`);
      return;
    }

    // current_code not found — fall through to LLM with a warning
    await log(workspace, `⚠️ Direct fix: \`current_code\` not found in file — falling back to LLM coder`);
  }

  // ── LLM coder (low confidence, retry, or direct apply failed) ──────────────
  await log(workspace, `🔧 Coder: applying fix to ${relevant_files.map(f => `\`${f}\``).join(', ')}...`);

  // Only pass the file being fixed — not all source files
  const fileContents = relevant_files.map(relPath =>
    `=== ${relPath} (EDIT THIS) ===\n${readFile(workspace, relPath)}`
  ).join('\n\n');

  // UAT scenarios — coder must verify against every scenario (capped at 20k to keep context manageable)
  const contextContents = (context_files ?? []).map(relPath => {
    const content = readFile(workspace, relPath);
    const capped = content.length > 20000 ? content.slice(0, 20000) + '\n\n[... truncated ...]' : content;
    return `=== ${relPath} (READ ONLY — verify your fix against every scenario) ===\n${capped}`;
  }).join('\n\n');

  const cachePrefix = [
    `Files to edit:\n${fileContents}`,
    contextContents ? `Reference context:\n${contextContents}` : '',
  ].filter(Boolean).join('\n\n');

  const fixInstruction = suggested_fix ? [
    `\n\nSuggested fix (implement this exactly — ONLY this, nothing else):`,
    `File: ${suggested_fix.file}`,
    `What: ${suggested_fix.what}`,
    `\nFind and replace this exact code:\n\`\`\`\n${suggested_fix.current_code}\n\`\`\``,
    `\nWith this:\n\`\`\`\n${suggested_fix.replacement_code}\n\`\`\``,
    suggested_fix.handles_cases?.length
      ? `\nThis handles:\n${suggested_fix.handles_cases.map(c => `  - ${c}`).join('\n')}`
      : '',
    `\nDo NOT fix any other field. Do NOT change bookingdate or any other validation.`,
    `Only the bookingtime section listed above changes. Everything else stays identical.`,
  ].filter(Boolean).join('\n') : '';

  const retryContext = buildRetryContext(manifest);

  const result = await promptJson({
    systemFile: path.join(__dirname, '../prompts/coder.md'),
    cacheUserPrefix: cachePrefix,
    userMessage: `Root cause: ${root_cause_summary}${fixInstruction}${retryContext}`,
    model: 'claude-sonnet-4-6',
    maxTokens: 8000,
  });

  // Apply patch-style changes — find/replace, never the full file
  const filesChanged = [];
  for (const { file: filePath, find, replace } of result.changes ?? []) {
    const absPath = path.join(workspace, filePath);
    if (!fs.existsSync(absPath)) {
      await log(workspace, `⚠️ Coder: file not found — ${filePath}`);
      continue;
    }
    const content = fs.readFileSync(absPath, 'utf8');
    const norm = s => s.replace(/\r\n/g, '\n');
    const normContent = norm(content);
    const normFind = norm(find);
    if (!normContent.includes(normFind)) {
      await log(workspace, `⚠️ Coder: \`find\` string not found in ${filePath} — skipping`);
      continue;
    }
    fs.writeFileSync(absPath, normContent.replace(normFind, norm(replace)), 'utf8');
    filesChanged.push(filePath);
  }

  if (filesChanged.length === 0) {
    await log(workspace, `❌ Coder: no changes applied — all find strings missing from files`);
    writeManifest(workspace, {
      verifier_output: { passed: false, passRate: null, errors: 'Coder produced no applicable changes' },
    });
    return;
  }

  const commit = commitAll(workspace, `fix(uat): ${manifest.task_id} - ${result.summary}`);

  const coverageLog = result.scenario_coverage
    ? Object.entries(result.scenario_coverage).map(([k, v]) => `  **${k}:** ${v}`).join('\n')
    : '(none)';

  writeManifest(workspace, {
    coder_output: {
      files_changed: filesChanged,
      summary: result.summary,
      scenario_coverage: result.scenario_coverage ?? null,
      commit_sha: commit.output,
    },
  });

  await log(workspace,
    `🔧 Coder done.\n` +
    `**Files changed:** ${filesChanged.map(f => `\`${f}\``).join(', ')}\n` +
    `**Summary:** ${result.summary}\n` +
    `**Scenario coverage:**\n${coverageLog}`);
}
