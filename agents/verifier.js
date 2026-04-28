import { readManifest, writeManifest } from '../orchestrator/index.js';
import { exec } from '../tools/shell.js';

export async function verify(workspace) {
  const manifest = readManifest(workspace);
  const testCommand = manifest.navigator_output?.test_command;

  if (!testCommand) {
    writeManifest(workspace, {
      verifier_output: { passed: false, output: '', errors: 'No test command found' },
    });
    return;
  }

  console.log(`[verifier] Running: ${testCommand}`);

  const result = exec(testCommand, {
    cwd: workspace,
    timeout: 180000,
    env: { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY },
  });

  // Check for uat-report.json if it exists (nation-booking style)
  let passed = result.success;
  let passRate = null;
  try {
    const report = JSON.parse(
      (await import('fs')).default.readFileSync(`${workspace}/uat-report.json`, 'utf8')
    );
    passRate = report.summary?.passRate;
    const threshold = parseFloat(process.env.UAT_PASS_THRESHOLD ?? '80');
    passed = passRate >= threshold;
  } catch {
    // No JSON report — fall back to exit code
  }

  writeManifest(workspace, {
    verifier_output: {
      passed,
      passRate,
      output: result.output,
      errors: result.errors ?? '',
    },
  });

  console.log(`[verifier] ${passed ? 'PASS' : 'FAIL'}${passRate != null ? ` (${passRate}%)` : ''}`);
}
