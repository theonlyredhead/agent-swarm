import Anthropic from '@anthropic-ai/sdk';
import fs from 'fs';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export async function prompt({ systemFile, userMessage, model = 'claude-opus-4-7', maxTokens = 8000 }) {
  const system = systemFile ? fs.readFileSync(systemFile, 'utf8') : undefined;

  const response = await client.messages.create({
    model,
    max_tokens: maxTokens,
    ...(system && { system }),
    messages: [{ role: 'user', content: userMessage }],
  });

  const text = response.content.find(b => b.type === 'text')?.text ?? '';

  // Strip markdown fences if present
  const stripped = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  return stripped;
}

export async function promptJson(args) {
  const text = await prompt(args);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Claude returned non-JSON: ${text.slice(0, 200)}`);
  }
}
