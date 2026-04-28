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

  await log(workspace, `🧪 Verifier (attempt ${attempt}, ${count} scenarios): running \`${testCommand}\`...`);

  const result = exec(testCommand, {
    cwd: workspace,
    timeout: 300000,
    env: { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY },
  });

  let passed = result.success;
  let passRate = null;

  try {
    const report = JSON.parse(fs.readFileSync(`${workspace}/uat-report.json`, 'utf8'));
    passRate = report.summary?.passRate;
    const threshold = parseFloat(process.env.UAT_PASS_THRESHOLD ?? '97');
    passed = passRate >= threshold;

    // Fail fast: if pass rate is very low on first attempt, not worth continuing
    if (attempt === 1 && passRate < 40) {
      await log(workspace, `⛔ Verifier: pass rate ${passRate}% on first attempt — failing fast`);
      writeManifest(workspace, {
        verifier_output: { passed: false, passRate, failFast: true, output: result.output, errors: result.errors ?? '' },
      });
      return;
    }
  } catch {
    // No JSON report — fall back to exit code
  }

  writeManifest(workspace, {
    verifier_output: { passed, passRate, output: result.output, errors: result.errors ?? '' },
  });

  await log(workspace,
    passed
      ? `✅ Verifier: PASS — ${passRate ?? 'ok'}%`
      : `❌ Verifier: FAIL — ${passRate ?? 'error'}% (attempt ${attempt})\n\`\`\`\n${result.errors || result.output}\n\`\`\``);
}
