import path from 'path';
import { fileURLToPath } from 'url';
import { readManifest } from '../orchestrator/index.js';
import { push } from '../tools/git.js';
import { createPR } from '../tools/github.js';
import { addComment, updateStatus } from '../tools/clickup.js';
import { prompt } from '../tools/claude.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export async function report({ workspace, org, orgConfig, repoName, task_id, branch, passed }) {
  const manifest = readManifest(workspace);
  const { verifier_output, coder_output, navigator_output } = manifest;

  if (!passed) {
    console.log(`[reporter] Tests failed — flagging for human review`);
    await addComment(task_id, orgConfig.clickupApiKey,
      `Agent attempted fix on \`${repoName}\` but tests did not pass.\n\n` +
      `**Test output:**\n\`\`\`\n${verifier_output.errors || verifier_output.output}\n\`\`\``
    );
    await updateStatus(task_id, orgConfig.clickupApiKey, orgConfig.statusFailed);
    return;
  }

  // Push branch
  push(workspace, branch, orgConfig.githubToken);

  // Generate PR description
  const prBody = await prompt({
    systemFile: path.join(__dirname, '../prompts/reporter.md'),
    userMessage: JSON.stringify({ task_id, root_cause: navigator_output.root_cause_summary, coder_output, verifier_output }),
    model: 'claude-haiku-4-5-20251001',
    maxTokens: 1000,
  });

  // Create PR
  const prUrl = await createPR({
    org,
    repo: repoName,
    token: orgConfig.githubToken,
    title: `fix(uat): ${task_id} — ${coder_output.summary}`,
    body: prBody,
    head: branch,
    base: orgConfig.prTargetBranch,
  });

  console.log(`[reporter] PR raised: ${prUrl}`);

  // Update ClickUp
  const passRate = verifier_output.passRate ? ` (UAT pass rate: ${verifier_output.passRate}%)` : '';
  await addComment(task_id, orgConfig.clickupApiKey,
    `PR raised for \`${repoName}\`: ${prUrl}${passRate}`
  );
  await updateStatus(task_id, orgConfig.clickupApiKey, orgConfig.statusDone);
}
