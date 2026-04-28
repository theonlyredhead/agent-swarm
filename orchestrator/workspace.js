import fs from 'fs';
import path from 'path';
import { clone, checkout } from '../tools/git.js';
import { exec } from '../tools/shell.js';

const BASE = process.env.WORKSPACE_BASE ?? '/tmp/swarm';

export function workspacePath(jobId, repoName) {
  return path.join(BASE, jobId, repoName);
}

export async function prepare(jobId, repoName, cloneUrl, branch, token) {
  const dest = workspacePath(jobId, repoName);
  clone(cloneUrl, dest, token);
  checkout(dest, branch);
  return dest;
}

export function cleanup(jobId, repoName) {
  const dest = workspacePath(jobId, repoName);
  if (fs.existsSync(dest)) exec(`rm -rf ${dest}`);
}
