import { exec } from './shell.js';
import fs from 'fs';
import path from 'path';

export function clone(repoUrl, destPath, token) {
  const authedUrl = repoUrl.replace('https://', `https://${token}@`);
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  return exec(`git clone ${authedUrl} ${destPath}`);
}

export function checkout(cwd, branch) {
  return exec(`git checkout -b ${branch}`, { cwd });
}

export function commitAll(cwd, message) {
  exec(`git config user.email "swarm@nation.com.au"`, { cwd });
  exec(`git config user.name "Nation Agent Swarm"`, { cwd });
  exec(`git add -A`, { cwd });
  const result = exec(`git commit -m "${message}"`, { cwd });
  if (!result.success && result.errors?.includes('nothing to commit')) {
    return { success: false, output: 'nothing to commit', skipped: true };
  }
  return result;
}

export function push(cwd, branch, token) {
  // Write credentials via git credential store — avoids shell quoting issues
  // when the token contains special chars or is very long
  const home = process.env.HOME ?? '/root';
  const credsPath = path.join(home, '.git-credentials');
  fs.writeFileSync(credsPath, `https://x-access-token:${token}@github.com\n`, { mode: 0o600 });
  exec(`git config --global credential.helper store`, { cwd });
  const pushResult = exec(`git push origin ${branch}`, { cwd });
  if (!pushResult.success) throw new Error(`git push failed: ${pushResult.errors}`);
  return pushResult;
}
