import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';
import { getOrg } from '../config/orgs.js';
import { listRepos } from '../tools/github.js';
import { triageRepos } from './triage.js';
import { prepare, cleanup } from './workspace.js';
import { addComment, updateStatus, filterTasks } from '../tools/clickup.js';
import { runAgent } from '../agent/index.js';

const MAX_CONCURRENT = parseInt(process.env.MAX_CONCURRENT_REPOS ?? '5');

export async function run({ org, task_id, failure_context, status = 'agent pickup' }) {
  const jobId = randomUUID();
  const orgConfig = getOrg(org);

  // Pick up task from ClickUp if not specified directly
  if (!task_id) {
    const listId = process.env.CLICKUP_LIST_ID;
    const result = await filterTasks(listId, orgConfig.clickupApiKey, status);
    const tasks = result.tasks ?? [];
    if (tasks.length === 0) {
      console.log(`[job:${jobId}] No tasks found in status "${status}" — exiting`);
      return;
    }
    const priority = { urgent: 0, high: 1, normal: 2, low: 3 };
    tasks.sort((a, b) => (priority[a.priority?.priority] ?? 9) - (priority[b.priority?.priority] ?? 9));
    const top = tasks[0];
    task_id = top.id;
    failure_context = `${top.name}\n\n${top.description ?? ''}`.trim();
    console.log(`[job:${jobId}] Picked up task ${task_id}: ${top.name}`);
    await updateStatus(task_id, orgConfig.clickupApiKey, 'in progress');
  }

  console.log(`[job:${jobId}] Starting — org=${org} task=${task_id}`);

  // Discover swarm-enabled repos
  const allRepos = await listRepos(org, orgConfig.githubToken);
  const repos = await filterSwarmEnabled(allRepos, org, orgConfig.githubToken);
  console.log(`[job:${jobId}] Discovered ${allRepos.length} repos → ${repos.length} swarm-enabled`);

  // Triage to relevant repos
  const triaged = repos.length === 1
    ? [{ repo: repos[0].name, confidence: 1.0 }]
    : await triageRepos(failure_context, repos);
  console.log(`[job:${jobId}] Triaged to ${triaged.length} relevant repo(s)`);

  if (triaged.length === 0) {
    await addComment(task_id, orgConfig.clickupApiKey, 'No repos matched — manual review required.');
    await updateStatus(task_id, orgConfig.clickupApiKey, 'needs human');
    return;
  }

  await addComment(task_id, orgConfig.clickupApiKey,
    `🤖 Agent picked up task.\nRepos: ${triaged.map(r => `\`${r.repo}\``).join(', ')}`);

  // Run one Claude agent per repo, in parallel
  const batches = chunk(triaged, MAX_CONCURRENT);
  for (const batch of batches) {
    await Promise.allSettled(batch.map(({ repo: repoName }) =>
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
    workspace = await prepare(jobId, repoName, repoMeta.clone_url, branch, orgConfig.githubToken);

    // Read swarm.config.json from the cloned workspace
    const swarmConfigPath = path.join(workspace, 'swarm.config.json');
    const swarmConfig = fs.existsSync(swarmConfigPath)
      ? JSON.parse(fs.readFileSync(swarmConfigPath, 'utf8'))
      : {};

    writeManifest(workspace, {
      job_id: jobId, org, task_id, failure_context,
      repo: repoName, workspace,
      swarm_config: swarmConfig,
    });

    // One Claude agent does everything: read → diagnose → fix → verify → PR
    await runAgent({ workspace, failureContext: failure_context, orgConfig, repoName, task_id, org, branch });

  } catch (err) {
    console.error(`[job:${jobId}] ${repoName} failed: ${err.message}`);
    await addComment(task_id, orgConfig.clickupApiKey, `❌ Error on \`${repoName}\`: ${err.message}`);
    await updateStatus(task_id, orgConfig.clickupApiKey, orgConfig.statusFailed);
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
    } catch { return null; }
  }));
  const enabled = results.filter(Boolean);
  if (enabled.length === 0) {
    console.log('[filter] No swarm.config.json — falling back to all repos');
    return repos;
  }
  return enabled;
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}
