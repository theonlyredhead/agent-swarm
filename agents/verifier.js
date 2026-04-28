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

// Normalise a scenario record to a stable ID string
function scenarioId(s) {
  return s.id ?? s.tc ?? s.name ?? s.scenario ?? s.title ?? null;
}

// Extract scenario IDs for passing and failing from a report
function extractScenarioSets(report) {
  const scenarios = report?.scenarios ?? [];
  return {
    passing: scenarios.filter(s => s.passed).map(scenarioId).filter(Boolean),
    failing: scenarios.filter(s => !s.passed).map(scenarioId).filter(Boolean),
  };
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

// Run UAT before the fix to capture the repo's natural pass rate and which
// scenarios pass. Stored in manifest so verify() can compute an exact delta.
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
  const baselineScenarios = report ? extractScenarioSets(report) : { passing: [], failing: [] };

  writeManifest(workspace, { baseline_pass_rate: baselinePassRate, baseline_scenarios: baselineScenarios });
  await log(workspace,
    `📊 Baseline: ${baselinePassRate !== null ? `${baselinePassRate}%` : 'unknown'} pass rate — ` +
    `${baselineScenarios.passing.length} passing, ${baselineScenarios.failing.length} failing`);
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

  const count = scenarioCount(attempt);
  if (testCommand.includes('index.js')) {
    testCommand = testCommand.replace(/--count \d+/, '').trim() + ` --count ${count}`;
  }

  const hasKey = !!process.env.ANTHROPIC_API_KEY;
  const uatExists = fs.existsSync(`${workspace}/uat-agent`);
  const pkgExists = fs.existsSync(`${workspace}/uat-agent/package.json`);
  await log(workspace,
    `🧪 Verifier pre-check:\n` +
    `- ANTHROPIC_API_KEY: ${hasKey ? 'set ✓' : 'MISSING ✗'}\n` +
    `- uat-agent dir: ${uatExists ? 'exists ✓' : 'MISSING ✗'}\n` +
    `- uat-agent/package.json: ${pkgExists ? 'exists ✓' : 'MISSING ✗'}\n` +
    `- Command: \`${testCommand}\``);

  await log(workspace, `🧪 Verifier (attempt ${attempt}, ${count} scenarios): running...`);

  const result = exec(testCommand, {
    cwd: workspace,
    timeout: 900000,
    env: { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY },
  });

  const baselinePassRate = manifest.baseline_pass_rate ?? null;
  const baselinePassing = new Set(manifest.baseline_scenarios?.passing ?? []);
  const tcCode = extractTargetTc(manifest);
  const threshold = parseFloat(process.env.UAT_PASS_THRESHOLD ?? '97');

  const report = readReport(workspace);

  let passed = result.success;
  let passRate = null;
  let regressions = [];
  let improvements = [];
  let tcPassed = false;

  if (report) {
    passRate = report.summary?.passRate;
    tcPassed = targetTcPassed(report, tcCode);

    const { passing: currentPassing } = extractScenarioSets(report);
    const currentPassingSet = new Set(currentPassing);

    // Scenarios that were passing before but broke with this fix
    regressions = [...baselinePassing].filter(id => !currentPassingSet.has(id));
    // Scenarios the fix actually fixed
    improvements = currentPassing.filter(id => !baselinePassing.has(id));

    passed = passRate >= threshold || (tcPassed && regressions.length === 0);

    // Log a clear delta summary
    const lines = [`📊 Delta from baseline (${baselinePassRate ?? '?'}% → ${passRate}%):`];
    if (tcPassed) lines.push(`  ✅ Target ${tcCode}: FIXED`);
    else if (tcCode) lines.push(`  ❌ Target ${tcCode}: still failing`);
    if (improvements.length) lines.push(`  ✅ Newly passing: ${improvements.join(', ')}`);
    if (regressions.length) lines.push(`  ⚠️  Regressions introduced: ${regressions.join(', ')}`);
    await log(workspace, lines.join('\n'));
  }

  writeManifest(workspace, {
    verifier_output: {
      passed, passRate, baselinePassRate,
      tcPassed, tcCode,
      regressions, improvements,
      output: result.output,
      errors: result.errors ?? '',
    },
  });

  const debugOutput = [result.errors, result.output].filter(Boolean).join('\n').slice(0, 1500);
  await log(workspace,
    passed
      ? `✅ Verifier: PASS — ${passRate ?? 'exit-0'}% (attempt ${attempt})`
      : `❌ Verifier: FAIL — ${passRate ?? 'no report'}% (attempt ${attempt})\n\`\`\`\n${debugOutput || 'no output captured'}\n\`\`\``);
}
