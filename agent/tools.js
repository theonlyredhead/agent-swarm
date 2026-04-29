import fs from 'fs';
import path from 'path';
import { exec } from '../tools/shell.js';
import { commitAll } from '../tools/git.js';
import { addComment } from '../tools/clickup.js';
import { log } from '../tools/log.js';

// ── Tool definitions (Anthropic API format) ───────────────────────────────────

export const TOOL_DEFINITIONS = [
  {
    name: 'list_files',
    description: 'List all source files in the repository. Use this first to understand the structure.',
    input_schema: {
      type: 'object',
      properties: {
        directory: {
          type: 'string',
          description: 'Subdirectory to list (default: repo root). E.g. "nation-booking/src"',
        },
      },
    },
  },
  {
    name: 'read_file',
    description: 'Read the full contents of a file.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative path from repo root' },
      },
      required: ['path'],
    },
  },
  {
    name: 'patch_file',
    description: `Apply a surgical find-and-replace to a file. Always prefer this over rewriting the whole file.
The system does a literal string search — 'find' must exist verbatim in the file including whitespace and indentation.
Read the file first to copy the exact string you want to replace.`,
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative path from repo root' },
        find: { type: 'string', description: 'Exact string to find — copied verbatim from the file' },
        replace: { type: 'string', description: 'Replacement string' },
      },
      required: ['path', 'find', 'replace'],
    },
  },
  {
    name: 'run_tests',
    description: 'Run the UAT test suite and return the pass rate and output. Start with 30 scenarios, use more on later attempts.',
    input_schema: {
      type: 'object',
      properties: {
        count: {
          type: 'number',
          description: 'Number of test scenarios (default 30, use 50-100 when close to passing)',
        },
      },
    },
  },
  {
    name: 'log',
    description: 'Post a progress update to ClickUp so the team can see what you are doing.',
    input_schema: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'Markdown-formatted progress update' },
      },
      required: ['message'],
    },
  },
  {
    name: 'verify_tc',
    description: `Run a targeted test focused specifically on the failing TC scenario type.
Unlike run_tests (which generates random scenarios), this generates scenarios
that specifically exercise the exact input pattern from the failing TC.
Use this after applying your fix to confirm the specific bug is resolved.
Returns pass rate and whether the targeted scenarios pass.`,
    input_schema: {
      type: 'object',
      properties: {
        tc_description: {
          type: 'string',
          description: 'Description of the failing TC, e.g. "POST /checkout with bookingtime field omitted should return 400"',
        },
        count: {
          type: 'number',
          description: 'Number of targeted scenarios to generate (default 10)',
        },
      },
      required: ['tc_description'],
    },
  },
  {
    name: 'complete',
    description: 'Call this when you are done — either the fix is verified and ready for PR, or you are escalating.',
    input_schema: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          enum: ['success', 'escalate'],
          description: '"success" = tests pass, ready for PR. "escalate" = cannot fix, needs human.',
        },
        summary: {
          type: 'string',
          description: 'What was fixed and how, or why you are escalating.',
        },
      },
      required: ['status', 'summary'],
    },
  },
];

// ── Tool implementations ──────────────────────────────────────────────────────

export function createToolHandlers(workspace, testCommand, orgConfig, task_id) {
  function safePath(relPath) {
    const abs = path.join(workspace, relPath);
    if (!abs.startsWith(workspace)) throw new Error(`Path escape: ${relPath}`);
    return abs;
  }

  return {
    list_files: ({ directory = '.' }) => {
      const result = exec(
        `find ${directory} -not -path "*/node_modules/*" -not -path "*/.git/*" -not -path "*/dist/*" -not -path "*/build/*" -maxdepth 4 -type f`,
        { cwd: workspace }
      );
      return result.output || '(empty)';
    },

    read_file: ({ path: relPath }) => {
      try {
        const abs = safePath(relPath);
        if (!fs.existsSync(abs)) return `File not found: ${relPath}`;
        const content = fs.readFileSync(abs, 'utf8');
        return content.length > 50000
          ? content.slice(0, 50000) + '\n\n[... file truncated at 50k chars ...]'
          : content;
      } catch (e) {
        return `Error reading file: ${e.message}`;
      }
    },

    patch_file: ({ path: relPath, find, replace }) => {
      try {
        const abs = safePath(relPath);
        if (!fs.existsSync(abs)) return `File not found: ${relPath}`;
        const content = fs.readFileSync(abs, 'utf8');
        const norm = s => s.replace(/\r\n/g, '\n');
        const normContent = norm(content);
        const normFind = norm(find);
        if (!normContent.includes(normFind)) {
          // Show surrounding context to help the agent correct itself
          const preview = content.split('\n').slice(260, 285).join('\n');
          return `ERROR: 'find' string not found verbatim in ${relPath}.\n\nLines 261-285 of the file for reference:\n${preview}\n\nRead the file again and copy the exact string.`;
        }
        const updated = normContent.replace(normFind, norm(replace));
        fs.writeFileSync(abs, updated, 'utf8');
        // Count lines changed
        const linesChanged = Math.abs(updated.split('\n').length - normContent.split('\n').length) +
          find.split('\n').length;
        return `Patched ${relPath} — ${linesChanged} lines affected.`;
      } catch (e) {
        return `Error patching file: ${e.message}`;
      }
    },

    run_tests: async ({ count = 30 }) => {
      const cmd = testCommand.replace(/--count \d+/, '').trim() + ` --count ${Math.min(count, 100)}`;
      const result = exec(cmd, {
        cwd: workspace,
        timeout: 900000,
        env: { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY },
      });

      const reportCandidates = [
        path.join(workspace, 'uat-agent/uat-report.json'),
        path.join(workspace, 'uat-report.json'),
      ];
      const reportPath = reportCandidates.find(p => fs.existsSync(p));
      let report = null;
      try { report = JSON.parse(fs.readFileSync(reportPath, 'utf8')); } catch {}

      const passRate = report?.summary?.passRate ?? report?.passRate ?? null;
      const passed = report?.summary?.passed ?? null;
      const total = report?.summary?.total ?? count;

      return JSON.stringify({
        pass_rate: passRate,
        passed,
        total,
        output: (result.output || '').slice(-2000),
        errors: (result.errors || '').slice(-500),
      }, null, 2);
    },

    verify_tc: async ({ tc_description, count = 10 }) => {
      // Build a targeted test command that biases scenario generation toward the failing TC
      const uatDir = path.join(workspace, 'uat-agent');
      if (!fs.existsSync(uatDir)) return 'uat-agent directory not found';

      const cmd = testCommand
        .replace(/--count \d+/, '').trim()
        + ` --count ${count} --focus "${tc_description.replace(/"/g, "'")}"`;

      const result = exec(cmd, {
        cwd: workspace,
        timeout: 600000,
        env: { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY },
      });

      const reportCandidates = [
        path.join(workspace, 'uat-agent/uat-report.json'),
        path.join(workspace, 'uat-report.json'),
      ];
      const reportPath = reportCandidates.find(p => fs.existsSync(p));
      let report = null;
      try { report = JSON.parse(fs.readFileSync(reportPath, 'utf8')); } catch {}

      const passRate = report?.summary?.passRate ?? report?.passRate ?? null;
      const passed = report?.summary?.passed ?? null;
      const total = report?.summary?.total ?? count;

      const verdict = passRate === null ? 'no report'
        : passRate >= 95 ? 'TC FIXED ✅'
        : passRate >= 80 ? 'PARTIAL — fix may be incomplete ⚠️'
        : 'TC STILL FAILING ❌';

      console.log(`[agent] verify_tc: ${passRate}% (${passed}/${total}) — ${verdict}`);

      return JSON.stringify({
        tc_description,
        pass_rate: passRate,
        passed,
        total,
        verdict,
        target: '95%',
        output: (result.output || '').slice(-1500),
      }, null, 2);
    },

    log: async ({ message }) => {
      await addComment(task_id, orgConfig.clickupApiKey, message);
      return 'Logged to ClickUp.';
    },

    complete: ({ status, summary }) => {
      // Signal to the agentic loop that we're done
      return JSON.stringify({ __complete: true, status, summary });
    },
  };
}
