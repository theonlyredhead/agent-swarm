import { promptJson } from '../tools/claude.js';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const THRESHOLD = parseFloat(process.env.TRIAGE_CONFIDENCE_THRESHOLD ?? '0.6');

export async function triageRepos(failureContext, repos) {
  const repoList = repos.map(r =>
    `- ${r.name}: ${r.description} [topics: ${r.topics.join(', ') || 'none'}]`
  ).join('\n');

  const result = await promptJson({
    systemFile: path.join(__dirname, '../prompts/triage.md'),
    userMessage: `Failure context:\n${failureContext}\n\nRepos:\n${repoList}`,
    model: 'claude-haiku-4-5-20251001',
    maxTokens: 2000,
  });

  return result
    .filter(r => r.confidence >= THRESHOLD)
    .sort((a, b) => b.confidence - a.confidence);
}
