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
import { verify } from '../agents/verifier.js';
import { report } from '../agents/reporter.js';

const MAX_CONCURRENT = parseInt(process.env.MAX_CONCURRENT_REPOS ?? '5');

export async function run({ org, task_id, failure_context }) {
  const jobId = randomUUID();
  const orgConfig = getOrg(org);

  // If no task supplied, fetch highest priority "Agent Execute" task from ClickUp
  if (!task_id) {
    const listId = process.env.CLICKUP_LIST_ID;
    const result = await filterTasks(listId, orgConfig.clickupApiKey, 'Agent Execute');
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
  }

  console.log(`[job:${jobId}] Starting — org=${org} task=${task_id}`);

  // 1. Discover repos
  const repos = await listRepos(org, orgConfig.githubToken);
  console.log(`[job:${jobId}] Discovered ${repos.length} active repos`);

  // 2. Triage — find relevant repos
  const triaged = await triageRepos(failure_context, repos);
  console.log(`[job:${jobId}] Triaged to ${triaged.length} relevant repos`);

  if (triaged.length === 0) {
    await addComment(task_id, orgConfig.clickupApiKey,
      'Agent swarm: no repos matched with sufficient confidence. Manual review required.');
    await updateStatus(task_id, orgConfig.clickupApiKey, 'needs human');
    return;
  }

  await addComment(task_id, orgConfig.clickupApiKey,
    `Agent swarm picked up this task. Checking ${triaged.length} repo(s): ${triaged.map(r => r.repo).join(', ')}`);

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
      navigator_output: null, coder_output: null,
      verifier_output: null, reporter_output: null,
    };
    writeManifest(workspace, jobManifest);

    // Run pipeline
    await navigate(workspace, failure_context);
    await code(workspace);
    await verify(workspace);
    await report({ workspace, org, orgConfig, repoName, task_id, branch });

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

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}
