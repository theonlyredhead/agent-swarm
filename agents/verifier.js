import fs from 'fs';
import { readManifest, writeManifest } from '../orchestrator/index.js';
import { exec } from '../tools/shell.js';
import { log } from '../tools/log.js';

// Scale scenario count based on attempt — cheap early, thorough when close
function scenarioCount(attempt) {
  if (attempt <= 1) return 30;
  if (attempt <= 3) return 50;
  return 100;
}

function readReport(workspace) {
  const candidates = [
    `${workspace}/uat-agent/uat-report.json`,
    `${workspace}/uat-report.json`,
  ];
  const reportPath = candidates.find(p => fs.existsSync(p));
  if (!reportPath) return null;
  try { return JSON.parse(fs.readFileSync(reportPath, 'utf8')); } catch { return null; }
}

// Extract the target TC code from the failure context (e.g. "TC-013")
function extractTargetTc(manifest) {
  return manifest.failure_context?.match(/TC-\d+/)?.[0] ?? null;
}

// Check if the target TC passed in this report
function targetTcPassed(report, tcCode) {
  if (!tcCode || !report?.scenarios) return false;
  return report.scenarios.some(s =>
    (s.id === tcCode || s.name?.includes(tcCode) || s.scenario?.includes(tcCode)) && s.passed
  );
}

// Run UAT before the fix to establish what the repo's natural pass rate is.
// Stored as baseline_pass_rate in the manifest so verify() can compare against it.
export async function baseline(workspace) {
  const manifest = readManifest(workspace);
  let testCommand = manifest.navigator_output?.test_command;
  if (!testCommand) return;

  const count = 20;
  if (testCommand.includes('index.js')) {
    testCommand = testCommand.replace(/--count \d+/, '').trim() + ` --count ${count}`;
  }

  await log(workspace, `📊 Verifier: running baseline UAT (${count} scenarios before fix)...`);

  exec(testCommand, {
    cwd: workspace,
    timeout: 900000,
    env: { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY },
  });

  const report = readReport(workspace);
  const baselinePassRate = report?.summary?.passRate ?? null;

  writeManifest(workspace, { baseline_pass_rate: baselinePassRate });
  await log(workspace, `📊 Baseline: ${baselinePassRate !== null ? `${baselinePassRate}%` : 'unknown'} pass rate (pre-fix)`);
}

export async function verify(workspace, attempt = 1) {
  const manifest = readManifest(workspace);
  let testCommand = manifest.navigator_output?.test_command;

  if (!testCommand) {
    writeManifest(workspace, {
      verifier_output: { passed: false, output: '', errors: 'No test command found' },
    });
    return;
  }

  // Inject --count for UAT agent runs to scale with attempt number
  const count = scenarioCount(attempt);
  if (testCommand.includes('index.js')) {
    testCommand = testCommand.replace(/--count \d+/, '').trim() + ` --count ${count}`;
  }

  // Pre-flight check — log workspace state and env to ClickUp
  const hasKey = !!process.env.ANTHROPIC_API_KEY;
  const uatExists = fs.existsSync(`${workspace}/uat-agent`);
  const pkgExists = fs.existsSync(`${workspace}/uat-agent/package.json`);
  await log(workspace, `🧪 Verifier pre-check:\n- ANTHROPIC_API_KEY: ${hasKey ? 'set ✓' : 'MISSING ✗'}\n- uat-agent dir: ${uatExists ? 'exists ✓' : 'MISSING ✗'}\n- uat-agent/package.json: ${pkgExists ? 'exists ✓' : 'MISSING ✗'}\n- Command: \`${testCommand}\``);

  await log(workspace, `🧪 Verifier (attempt ${attempt}, ${count} scenarios): running...`);

  const result = exec(testCommand, {
    cwd: workspace,
    timeout: 900000, // 15 min — batch API needs time to process
    env: { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY },
  });

  let passed = result.success;
  let passRate = null;
  const baselinePassRate = manifest.baseline_pass_rate ?? null;
  const tcCode = extractTargetTc(manifest);
  const threshold = parseFloat(process.env.UAT_PASS_THRESHOLD ?? '97');

  const report = readReport(workspace);

  if (report) {
    passRate = report.summary?.passRate;

    // Pass if overall threshold met OR the specific target TC now passes
    const tcNowPasses = targetTcPassed(report, tcCode);
    passed = passRate >= threshold || tcNowPasses;

    if (tcNowPasses && passRate < threshold) {
      await log(workspace, `🎯 ${tcCode} passes — target TC fixed (overall: ${passRate}%)`);
    }

    // Fail fast only if the fix made things measurably worse, or nothing works at all
    if (attempt === 1 && !passed) {
      const madeThingsWorse = baselinePassRate !== null && passRate < baselinePassRate - 5;
      const completelyBroken = passRate === 0 && (baselinePassRate === null || baselinePassRate > 0);

      if (madeThingsWorse || completelyBroken) {
        const reason = madeThingsWorse
          ? `pass rate dropped from baseline ${baselinePassRate}% → ${passRate}%`
          : `pass rate is 0% — fix may have broken something`;
        await log(workspace, `⛔ Verifier: failing fast — ${reason}`);
        writeManifest(workspace, {
          verifier_output: { passed: false, passRate, failFast: true, output: result.output, errors: result.errors ?? '' },
        });
        return;
      }
    }
  } else {
    // No JSON report — fall back to exit code
  }

  writeManifest(workspace, {
    verifier_output: { passed, passRate, output: result.output, errors: result.errors ?? '' },
  });

  const debugOutput = [result.errors, result.output].filter(Boolean).join('\n').slice(0, 1000);
  await log(workspace,
    passed
      ? `✅ Verifier: PASS — ${passRate ?? 'exit-0'}% (attempt ${attempt})`
      : `❌ Verifier: FAIL — ${passRate ?? 'no report'}% (attempt ${attempt})\n\`\`\`\n${debugOutput || 'no output captured'}\n\`\`\``);
}
