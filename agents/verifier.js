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

// Normalise a scenario record to a stable ID string, trying every common field name
function scenarioId(s) {
  return s.id ?? s.tc ?? s.name ?? s.scenario ?? s.title ?? s.description ?? null;
}

// UAT agents use different keys for the scenario array — try all of them
function getScenarioList(report) {
  return report?.scenarios ?? report?.results ?? report?.cases ?? report?.tests ?? [];
}

// Check if a scenario record represents the scenario passing
function scenarioPassed(s) {
  return s.passed === true || s.pass === true || s.status === 'pass' || s.status === 'passed' || s.result === 'pass';
}

// Extract passing and failing scenario IDs from report, regardless of structure
function extractScenarioSets(report) {
  const list = getScenarioList(report);
  return {
    passing: list.filter(s => scenarioPassed(s)).map(scenarioId).filter(Boolean),
    failing: list.filter(s => !scenarioPassed(s)).map(scenarioId).filter(Boolean),
  };
}

// Extract TC code from failure context (e.g. "TC-013")
function extractTargetTc(manifest) {
  return manifest.failure_context?.match(/TC-\d+/)?.[0] ?? null;
}

// Detect whether the target behaviour is now passing — two strategies:
// 1. Exact TC ID match in scenario records (works when UAT uses fixed IDs)
// 2. Semantic match: scan scenario descriptions for the failure keywords (works with generated scenarios)
function detectTargetTcPassed(report, manifest) {
  const tcCode = extractTargetTc(manifest);
  const list = getScenarioList(report);
  if (!list.length) return { found: false, passed: false };

  // Strategy 1: exact ID match
  if (tcCode) {
    const exact = list.find(s =>
      s.id === tcCode || s.tc === tcCode ||
      s.name?.includes(tcCode) || s.scenario?.includes(tcCode) || s.description?.includes(tcCode)
    );
    if (exact) return { found: true, passed: scenarioPassed(exact) };
  }

  // Strategy 2: semantic match — extract keywords from failure context
  // e.g. "bookingtime is not required" → look for scenarios about missing bookingtime → expect 400
  const ctx = (manifest.failure_context ?? '').toLowerCase();
  const keywords = ctx.match(/\b([a-z_]+time|[a-z_]+date|[a-z_]+field)\b/g) ?? [];

  if (keywords.length) {
    const semantic = list.filter(s => {
      const desc = (scenarioId(s) ?? '').toLowerCase();
      return keywords.some(kw => desc.includes(kw)) && !scenarioPassed(s) === false;
    });
    // If we find scenarios matching our keywords that now pass, treat as fixed
    const semanticPassing = semantic.filter(s => scenarioPassed(s));
    if (semanticPassing.length > 0) return { found: true, passed: true };
  }

  return { found: false, passed: false };
}

// Run UAT before the fix to capture the repo's natural pass rate and passing scenario IDs
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
  const baselinePassRate = report?.summary?.passRate ?? report?.passRate ?? null;
  const baselineScenarios = report ? extractScenarioSets(report) : { passing: [], failing: [] };

  writeManifest(workspace, { baseline_pass_rate: baselinePassRate, baseline_scenarios: baselineScenarios });
  await log(workspace,
    `📊 Baseline: ${baselinePassRate !== null ? `${baselinePassRate}%` : 'unknown'} pass rate — ` +
    `${baselineScenarios.passing.length} scenarios identified as passing`);
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
  const threshold = parseFloat(process.env.UAT_PASS_THRESHOLD ?? '97');
  const improvementThreshold = parseFloat(process.env.IMPROVEMENT_THRESHOLD ?? '30');

  const report = readReport(workspace);

  let passed = result.success;
  let passRate = null;
  let regressions = [];
  let improvements = [];
  let tcCode = extractTargetTc(manifest);
  let tcPassed = false;

  if (report) {
    passRate = report.summary?.passRate ?? report.passRate ?? null;

    const { passed: currentPassing } = extractScenarioSets(report);
    const currentPassingSet = new Set(currentPassing);

    regressions = [...baselinePassing].filter(id => !currentPassingSet.has(id));
    improvements = currentPassing.filter(id => !baselinePassing.has(id));

    const tcDetection = detectTargetTcPassed(report, manifest);
    tcPassed = tcDetection.passed;

    // Pass conditions (any one is sufficient):
    // 1. Overall threshold met (e.g. 97%)
    // 2. Target TC explicitly passes and no regressions
    // 3. Significant improvement over baseline with no regressions
    //    (handles case where UAT generates random scenarios — we can't pin TC-013 exactly,
    //     but +30pp improvement with zero regressions is a strong signal the fix is correct)
    const significantImprovement = baselinePassRate !== null
      && passRate !== null
      && (passRate - baselinePassRate) >= improvementThreshold
      && regressions.length === 0;

    passed =
      passRate >= threshold ||
      (tcPassed && regressions.length === 0) ||
      significantImprovement;

    // Build a clear delta log
    const lines = [`📊 Delta from baseline (${baselinePassRate ?? '?'}% → ${passRate}%):`];
    if (tcDetection.found) {
      lines.push(tcPassed ? `  ✅ Target ${tcCode}: FIXED` : `  ❌ Target ${tcCode}: still failing`);
    } else {
      lines.push(`  ℹ️  Target ${tcCode}: not directly detectable in generated scenarios (using rate delta)`);
    }
    if (significantImprovement) lines.push(`  ✅ Significant improvement (+${(passRate - baselinePassRate).toFixed(1)}pp, no regressions) — treating as PASS`);
    if (improvements.length) lines.push(`  ✅ Newly passing: ${improvements.slice(0, 5).join(', ')}${improvements.length > 5 ? ` +${improvements.length - 5} more` : ''}`);
    if (regressions.length) lines.push(`  ⚠️  Regressions: ${regressions.join(', ')}`);
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
