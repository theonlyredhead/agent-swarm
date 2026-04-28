import Anthropic from '@anthropic-ai/sdk';
import fs from 'fs';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const JSON_ENFORCEMENT = 'IMPORTANT: Your response must be valid JSON only. No prose, no explanation, no markdown fences. Start your response with { or [ and end with } or ].';

export async function prompt({ systemFile, userMessage, model = 'claude-sonnet-4-6', maxTokens = 8000, cacheUserPrefix = null }) {
  const systemText = systemFile ? fs.readFileSync(systemFile, 'utf8') : null;

  const system = systemText
    ? [{ type: 'text', text: systemText, cache_control: { type: 'ephemeral' } }]
    : undefined;

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

  // 1. Direct parse
  try { return JSON.parse(text); } catch {}

  // 2. Extract JSON object or array from prose
  const objMatch = text.match(/\{[\s\S]*\}/);
  const arrMatch = text.match(/\[[\s\S]*\]/);
  const extracted = objMatch?.[0] ?? arrMatch?.[0];
  if (extracted) {
    try { return JSON.parse(extracted); } catch {}
  }

  // 3. Send a correction turn asking for JSON only
  console.warn('[claude] Non-JSON response — sending correction turn');
  const systemText = args.systemFile ? fs.readFileSync(args.systemFile, 'utf8') : null;
  const system = systemText
    ? [{ type: 'text', text: systemText, cache_control: { type: 'ephemeral' } }]
    : undefined;

  const correction = await client.messages.create({
    model: args.model ?? 'claude-sonnet-4-6',
    max_tokens: args.maxTokens ?? 8000,
    ...(system && { system }),
    messages: [
      { role: 'user', content: args.userMessage },
      { role: 'assistant', content: text },
      { role: 'user', content: JSON_ENFORCEMENT },
    ],
  });

  const corrected = correction.content.find(b => b.type === 'text')?.text ?? '';
  const cleaned = corrected.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();

  try { return JSON.parse(cleaned); } catch {}

  // Extract from corrected response
  const obj2 = cleaned.match(/\{[\s\S]*\}/);
  const arr2 = cleaned.match(/\[[\s\S]*\]/);
  const extracted2 = obj2?.[0] ?? arr2?.[0];
  if (extracted2) {
    try { return JSON.parse(extracted2); } catch {}
  }

  throw new Error(`Claude returned non-JSON after correction: ${cleaned.slice(0, 300)}`);
}
