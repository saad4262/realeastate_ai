/**
 * Once per environment (ADR 0072): make the platform's Retell LLM and agent for the AI call back, from
 * prompts/ai-callback-v1.ts, with its webhook on this server. Prints RETELL_AGENT_ID to set on the web
 * project. Run again after a prompt change (it makes a new agent; set the new id).
 *
 *   RETELL_API_KEY=… PHONE_WEBHOOK_BASE=https://<web host> pnpm --filter @repo/ai retell:setup
 *
 * Not an LLM call by us: it sends Retell the configuration its own model runs with. PROVISIONAL until
 * run against a real Retell account (field names from Retell's API reference, 2026-10-30).
 */
import { config } from 'dotenv';
import { tokenKeysFromEnv } from '@repo/core/integrations';
import { retellWebhookUrl } from '@repo/core/phone';
import { AI_CALLBACK_ANALYSIS, AI_CALLBACK_BEGIN_MESSAGE, AI_CALLBACK_GENERAL_PROMPT, AI_CALLBACK_PROMPT_VERSION } from '../prompts/ai-callback-v1';

config({ path: '../../.env.local' });

async function retell(path: string, body: unknown, apiKey: string): Promise<Record<string, unknown>> {
  const res = await fetch(`https://api.retellai.com${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new Error(`Retell ${path} answered ${res.status}`);
  return json;
}

async function main() {
  const apiKey = process.env.RETELL_API_KEY?.trim();
  const base = process.env.PHONE_WEBHOOK_BASE?.trim() || process.env.NEXT_PUBLIC_WEB_URL?.trim();
  const keys = tokenKeysFromEnv();
  if (!apiKey || !base || !keys) throw new Error('Set RETELL_API_KEY, PHONE_WEBHOOK_BASE (https) and INTEGRATION_TOKEN_KEY first.');
  if (!base.startsWith('https://')) throw new Error('PHONE_WEBHOOK_BASE must be the web app’s public https URL.');
  const llm = await retell('/create-retell-llm', { general_prompt: AI_CALLBACK_GENERAL_PROMPT, begin_message: AI_CALLBACK_BEGIN_MESSAGE }, apiKey);
  const llmId = String(llm.llm_id ?? '');
  if (!llmId) throw new Error('Retell did not return an llm_id');
  const agent = await retell(
    '/create-agent',
    {
      agent_name: `LocalAgent AI call back (${AI_CALLBACK_PROMPT_VERSION})`,
      response_engine: { type: 'retell-llm', llm_id: llmId },
      voice_id: process.env.RETELL_VOICE_ID?.trim() || '11labs-Adrian',
      language: 'en-AU',
      webhook_url: retellWebhookUrl(base, keys),
      post_call_analysis_data: AI_CALLBACK_ANALYSIS,
      max_call_duration_ms: 4 * 60 * 1000,
    },
    apiKey,
  );
  const agentId = String(agent.agent_id ?? '');
  if (!agentId) throw new Error('Retell did not return an agent_id');
  console.log(`Retell LLM ${llmId}\nSet on the web project:\nRETELL_AGENT_ID=${agentId}`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
