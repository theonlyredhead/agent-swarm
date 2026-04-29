import Anthropic from '@anthropic-ai/sdk';
import { TOOL_DEFINITIONS, createToolHandlers } from './tools.js';
import { readManifest, writeManifest } from '../orchestrator/index.js';
import { commitAll, push } from '../tools/git.js';
import { createPR } from '../tools/github.js';
import { addComment, updateStatus } from '../tools/clickup.js';
import { log } from '../tools/log.js';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const SYSTEM_PROMPT = `You are a senior software engineer autonomously fixing a production bug. You have tools to read source code, apply precise fixes, and run tests.

## Your process
1. log() — announce you've started and what you're investigating
2. list_files() — understand the repo structure
3. read_file() — read the relevant source file AND the UAT scenario file
4. Find the exact bug. Quote the buggy line to yourself before touching anything
5. run_tests(count: 20) — establish baseline pass rate
6. patch_file() — apply the minimal fix. Copy the find string verbatim from the file
7. verify_tc() — run a targeted test specifically for the failing TC scenario. This is your primary pass signal
8. If verify_tc passes (≥95%): call complete(status: 'success')
9. If verify_tc fails: read the output, understand why, try a different fix. Max 3 attempts
10. After 3 failed attempts: complete(status: 'escalate')

## Hard rules
- Read the code before touching it — never guess
- patch_file() does a literal string search — copy find verbatim from the file
- Fix ONLY the specific field/condition in the failing TC — nothing else
- The test suite evaluates your modified source code statically
- verify_tc() is the definitive check — overall pass rate includes pre-existing unrelated bugs`;

export async function runAgent({
  workspace, failureContext, orgConfig, repoName, task_id, org, branch,
}) {
  const manifest = readManifest(workspace);
  const testCommand = manifest.swarm_config?.test_command
    ?? 'npm --prefix uat-agent install && node uat-agent/index.js --count 30';

  const tools = createToolHandlers(workspace, testCommand, orgConfig, task_id);

  const messages = [{
    role: 'user',
    content: `## Failing test case\n${failureContext}\n\n## Repo\n${repoName}\n\nFix this. Read the code, find the exact bug, apply the minimal fix, verify with tests.`,
  }];

  const MAX_ITERATIONS = 25;
  let iteration = 0;
  let fixAttempts = 0;
  let baselinePassRate = null;
  let result = { status: 'escalate', summary: 'Max iterations reached without fix' };

  console.log(`\n[agent] Starting on task ${task_id} — ${repoName}`);

  while (iteration < MAX_ITERATIONS) {
    iteration++;

    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 16000,
      thinking: { type: 'enabled', budget_tokens: 8000 },
      system: SYSTEM_PROMPT,
      tools: TOOL_DEFINITIONS,
      messages,
    });

    // Log token usage
    const u = response.usage;
    if (u?.cache_read_input_tokens || u?.cache_creation_input_tokens) {
      console.log(`[agent] cache: read=${u.cache_read_input_tokens ?? 0} written=${u.cache_creation_input_tokens ?? 0}`);
    }

    // Append assistant turn
    messages.push({ role: 'assistant', content: response.content });

    if (response.stop_reason === 'end_turn') {
      console.log(`[agent] End turn at iteration ${iteration}`);
      break;
    }

    if (response.stop_reason !== 'tool_use') break;

    // Execute all tool calls in this turn
    const toolResults = [];
    for (const block of response.content) {
      if (block.type !== 'tool_use') continue;

      const handler = tools[block.name];
      if (!handler) {
        toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: `Unknown tool: ${block.name}` });
        continue;
      }

      console.log(`[agent] → ${block.name}(${JSON.stringify(block.input).slice(0, 120)})`);

      let output;
      try {
        output = await handler(block.input);
      } catch (e) {
        output = `Tool error: ${e.message}`;
      }

      const outputStr = typeof output === 'string' ? output : JSON.stringify(output);

      // Track state
      if (block.name === 'patch_file' && !outputStr.startsWith('ERROR')) {
        fixAttempts++;
      }
      if (block.name === 'run_tests') {
        try {
          const parsed = JSON.parse(outputStr);
          if (baselinePassRate === null && fixAttempts === 0) {
            baselinePassRate = parsed.pass_rate;
            console.log(`[agent] Baseline: ${baselinePassRate}%`);
          } else {
            console.log(`[agent] Test result: ${parsed.pass_rate}% (baseline: ${baselinePassRate}%)`);
          }
        } catch {}
      }
      if (block.name === 'complete') {
        try {
          const parsed = JSON.parse(outputStr);
          result = { status: parsed.status, summary: parsed.summary };
        } catch {}
        // Terminate the loop
        messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: block.id, content: outputStr }] });
        iteration = MAX_ITERATIONS; // break outer loop
        break;
      }

      toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: outputStr });
    }

    if (toolResults.length > 0) {
      messages.push({ role: 'user', content: toolResults });
    }
  }

  // ── Report outcome ──────────────────────────────────────────────────────────
  if (result.status === 'success') {
    // Commit any uncommitted changes (agent uses patch_file which doesn't auto-commit)
    const commitResult = commitAll(workspace, `fix(uat): ${task_id} — ${result.summary.slice(0, 72)}`);
    if (commitResult.skipped) {
      console.log('[agent] Nothing new to commit — workspace may already be clean');
    }

    // Push branch — throws if push fails
    push(workspace, branch, orgConfig.githubToken);

    // Build PR description
    const prBody = `## Fix\n${result.summary}\n\n## Verified\nUAT pass rate improved from baseline ${baselinePassRate ?? '?'}%.\n\n🤖 Fixed autonomously by Claude agent swarm`;

    const prUrl = await createPR({
      org, repo: repoName,
      token: orgConfig.githubToken,
      title: `fix(uat): ${task_id} — ${result.summary.slice(0, 60)}`,
      body: prBody,
      head: branch,
      base: orgConfig.prTargetBranch,
    });

    console.log(`[agent] PR raised: ${prUrl}`);
    await addComment(task_id, orgConfig.clickupApiKey, `✅ Fix verified. PR raised: ${prUrl}`);
    await updateStatus(task_id, orgConfig.clickupApiKey, orgConfig.statusDone);
  } else {
    await addComment(task_id, orgConfig.clickupApiKey,
      `🔴 Agent could not fix this after ${fixAttempts} attempts.\n\n**Reason:** ${result.summary}`);
    await updateStatus(task_id, orgConfig.clickupApiKey, orgConfig.statusFailed);
  }

  writeManifest(workspace, { agent_result: result, fix_attempts: fixAttempts, baseline_pass_rate: baselinePassRate });
  return result;
}
