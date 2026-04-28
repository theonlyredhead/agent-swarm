import Anthropic from '@anthropic-ai/sdk';
import fs from 'fs';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export async function prompt({ systemFile, userMessage, model = 'claude-opus-4-7', maxTokens = 8000, cacheUserPrefix = null }) {
  const systemText = systemFile ? fs.readFileSync(systemFile, 'utf8') : null;

  // System prompt cached — static .md files don't change between runs
  const system = systemText
    ? [{ type: 'text', text: systemText, cache_control: { type: 'ephemeral' } }]
    : undefined;

  // Optionally cache a large static prefix in the user message (e.g. file contents)
  // cacheUserPrefix = string of static content to cache before the dynamic part
  const messages = cacheUserPrefix
    ? [{
        role: 'user',
        content: [
          { type: 'text', text: cacheUserPrefix, cache_control: { type: 'ephemeral' } },
          { type: 'text', text: userMessage },
        ],
      }]
    : [{ role: 'user', content: userMessage }];

  const response = await client.messages.create({
    model,
    max_tokens: maxTokens,
    ...(system && { system }),
    messages,
  });

  // Log cache performance in CI
  const usage = response.usage;
  if (usage?.cache_read_input_tokens || usage?.cache_creation_input_tokens) {
    const saved = usage.cache_read_input_tokens ?? 0;
    const written = usage.cache_creation_input_tokens ?? 0;
    console.log(`[cache] read=${saved} written=${written} uncached=${usage.input_tokens}`);
  }

  const text = response.content.find(b => b.type === 'text')?.text ?? '';
  return text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
}

export async function promptJson(args) {
  const text = await prompt(args);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Claude returned non-JSON: ${text.slice(0, 200)}`);
  }
}
