import { execSync } from 'child_process';

export function exec(command, { cwd = process.cwd(), timeout = 60000, env = {} } = {}) {
  try {
    const output = execSync(command, {
      cwd,
      timeout,
      env: { ...process.env, ...env },
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { success: true, output: output.trim() };
  } catch (err) {
    return {
      success: false,
      output: err.stdout?.trim() ?? '',
      errors: err.stderr?.trim() ?? err.message,
    };
  }
}
