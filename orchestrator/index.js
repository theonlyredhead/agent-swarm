import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';
import { getOrg } from '../config/orgs.js';
import { listRepos } from '../tools/github.js';
import { triageRepos } from './triage.js';
import { prepare, cleanup } from './workspace.js';
import { addComment, updateStatus, filterTasks } from '../tools/clickup.js';
import { navigate } from '../agents/navigator.js';
import { code } from '../agents/coder.js';
import { baseline, verify } from '../agents/verifier.js';
import { report } from '../agents/reporter.js';
import { log } from '../tools/log.js';

const MAX_CONCURRENT = parseInt(process.env.MAX_CONCURRENT_REPOS ?? '5');

export async function run({ org, task_id, failure_context, status = 'agent pickup' }) {
  const jobId = randomUUID();
  const orgConfig = getOrg(org);

  // If no task supplied, fetch highest priority task from ClickUp
  if (!task_id) {
    const listId = process.env.CLICKUP_LIST_ID;
    const result = await filterTasks(listId, orgConfig.clickupApiKey, status);
    const tasks = result.tasks ?? [];
    if (tasks.length === 0) {
      console.log(`[job:${jobId}] No Agent Execute tasks found — exiting`);
      return;
    }
    const priority = { urgent: 0, high: 1, normal: 2, low: 3 };
    tasks.sort((a, b) => (priority[a.priority?.priority] ?? 9) - (priority[b.priority?.priority] ?? 9));
    const top = tasks[0];
    task_id = top.id;
    failure_context = `${top.name}\n\n${top.description ?? ''}`.trim();
    console.log(`[job:${jobId}] Picked up task ${task_id}: ${top.name}`);

    // Lock the task immediately so concurrent runs skip it
    await updateStatus(task_id, orgConfig.clickupApiKey, 'in progress');
  }

  console.log(`[job:${jobId}] Starting — org=${org} task=${task_id}`);

  // 1. Discover repos — filter to only those with swarm.config.json enabled
  const allRepos = await listRepos(org, orgConfig.githubToken);
  const repos = await filterSwarmEnabled(allRepos, org, orgConfig.githubToken);
  console.log(`[job:${jobId}] Discovered ${allRepos.length} repos → ${repos.length} swarm-enabled`);

  // 2. Triage — find relevant repos (much smaller set now)
  const triaged = repos.length === 1
    ? [{ repo: repos[0].name, confidence: 1.0, reason: 'Only swarm-enabled repo' }]
    : await triageRepos(failure_context, repos);
  console.log(`[job:${jobId}] Triaged to ${triaged.length} relevant repos`);

  if (triaged.length === 0) {
    await addComment(task_id, orgConfig.clickupApiKey,
      'Agent swarm: no repos matched with sufficient confidence. Manual review required.');
    await updateStatus(task_id, orgConfig.clickupApiKey, 'needs human');
    return;
  }

  await addComment(task_id, orgConfig.clickupApiKey,
    `🤖 Agent swarm picked up this task.\n` +
    `Discovered ${repos.length} repos → triaged to ${triaged.length} relevant: ${triaged.map(r => `\`${r.repo}\` (${Math.round(r.confidence * 100)}%)`).join(', ')}`);

  // 3. Process repos in parallel (up to MAX_CONCURRENT)
  const batches = chunk(triaged, MAX_CONCURRENT);
  for (const batch of batches) {
    await Promise.all(batch.map(({ repo: repoName }) =>
      processRepo({ jobId, org, orgConfig, repoName, task_id, failure_context, repos })
    ));
  }

  console.log(`[job:${jobId}] Done`);
}

async function processRepo({ jobId, org, orgConfig, repoName, task_id, failure_context, repos }) {
  const repoMeta = repos.find(r => r.name === repoName);
  if (!repoMeta) return;

  const branch = `fix/uat-${task_id}`;
  let workspace;

  try {
    // Clone + branch
    workspace = await prepare(jobId, repoName, repoMeta.clone_url, branch, orgConfig.githubToken);

    // Write job manifest
    const jobManifest = {
      job_id: jobId, org, task_id, failure_context,
      repo: repoName, workspace,
      clickup_api_key: orgConfig.clickupApiKey,
      navigator_output: null, coder_output: null,
      verifier_output: null, reporter_output: null,
    };
    writeManifest(workspace, jobManifest);

    // Run pipeline
    await navigate(workspace, failure_context);
    await baseline(workspace); // pre-fix pass rate — used by verifier to detect regressions
    await code(workspace);

    // UAT loop — iterate until 97% or max attempts
    const MAX_ATTEMPTS = parseInt(process.env.MAX_UAT_ATTEMPTS ?? '5');
    let attempt = 1;
    let verifierPassed = false;

    while (attempt <= MAX_ATTEMPTS) {
      await verify(workspace, attempt);
      const { passed, passRate, failFast } = readManifest(workspace).verifier_output;

      if (passed) { verifierPassed = true; break; }
      if (failFast) break;
      if (attempt === MAX_ATTEMPTS) break;

      // Re-run coder with failure context before next attempt
      await log(workspace, `🔁 Retrying fix (attempt ${attempt + 1}/${MAX_ATTEMPTS}) — pass rate was ${passRate ?? 'unknown'}%`);
      await code(workspace);
      attempt++;
    }

    await report({ workspace, org, orgConfig, repoName, task_id, branch, passed: verifierPassed });

  } catch (err) {
    console.error(`[job:${jobId}] ${repoName} failed: ${err.message}`);
    await addComment(task_id, orgConfig.clickupApiKey,
      `Error processing ${repoName}: ${err.message}`);
  } finally {
    if (workspace) cleanup(jobId, repoName);
  }
}

export function writeManifest(workspace, data) {
  const existing = readManifest(workspace);
  fs.writeFileSync(path.join(workspace, 'job.json'), JSON.stringify({ ...existing, ...data }, null, 2));
}

export function readManifest(workspace) {
  const p = path.join(workspace, 'job.json');
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : {};
}

async function filterSwarmEnabled(repos, org, token) {
  const results = await Promise.all(repos.map(async repo => {
    try {
      const res = await fetch(
        `https://api.github.com/repos/${org}/${repo.name}/contents/swarm.config.json`,
        { headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' } }
      );
      if (!res.ok) return null;
      const file = await res.json();
      const config = JSON.parse(Buffer.from(file.content, 'base64').toString('utf8'));
      const enabled = config.enabled !== false;
      if (enabled) console.log(`[filter] swarm-enabled: ${repo.name}`);
      return enabled ? repo : null;
    } catch {
      return null;
    }
  }));
  const enabled = results.filter(Boolean);
  // Fallback: if no opted-in repos found (token lacks contents:read), use all repos
  if (enabled.length === 0) {
    console.log('[filter] No swarm.config.json found — falling back to full repo list for triage');
    return repos;
  }
  return enabled;
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}
