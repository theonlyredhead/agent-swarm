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
  exec(`git add -A`, { cwd });
  return exec(`git commit -m "${message}"`, { cwd });
}

export function push(cwd, branch, token) {
  const result = exec(`git remote get-url origin`, { cwd });
  const authedUrl = result.output.replace('https://', `https://${token}@`);
  exec(`git remote set-url origin ${authedUrl}`, { cwd });
  return exec(`git push origin ${branch}`, { cwd });
}
