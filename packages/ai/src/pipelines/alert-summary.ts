import Anthropic from '@anthropic-ai/sdk';
import { getModel, type TokenUsage } from '../models';
import { ALERT_SUMMARY_PROMPT_VERSION, ALERT_SUMMARY_V1 } from '../prompts/alert-summary-v1';

export type AlertSummaryFacts = {
  /** Server-authored words for the filters. The model never writes this. */
  description: string;
  matched: number;
  newCount: number;
  /** Preformatted strings. There is no number in here to do arithmetic on. */
  listings: { headline: string; address: string; price: string; specs: string | null }[];
};

export type AlertSummaryResult =
  | { source: 'model'; text: string }
  | { source: 'template'; text: null; rejected?: string };

/**
 * Anything that looks like a figure.
 *
 * Rejecting rather than stripping, deliberately: a sentence with its number
 * cut out reads as broken, and a broken sentence in somebody's inbox is a
 * worse email than a plain templated one. This is the layer to break in
 * order to prove the check works.
 *
 * Exported because the test drives it directly — going through the model to
 * test a regular expression would cost money and prove less.
 */
export function findFigures(text: string): string | null {
  const patterns: [RegExp, string][] = [
    [/\$/, 'dollar sign'],
    [/\d/, 'digit'],
    [/\b(?:one|two|three|four|five|six|seven|eight|nine|ten|dozen)\b/i, 'written-out count'],
    [/\b(?:per cent|percent|%)/i, 'percentage'],
  ];

  for (const [pattern, label] of patterns) {
    const hit = pattern.exec(text);
    if (hit) return `${label} (${hit[0]})`;
  }

  return null;
}

/**
 * The facts, as the model sees them.
 *
 * Counts are described in words rather than given as integers, because the
 * model is forbidden from writing a number and handing it one is an
 * invitation. The email prints the real figures itself, from SQL.
 */
function factsMessage(facts: AlertSummaryFacts): string {
  const scale =
    facts.newCount === 1 ? 'a single new listing' : 'several new listings';

  const lines = facts.listings.map((l) => {
    const bits = [l.headline || l.address, l.price, l.specs].filter(Boolean);
    return `- ${bits.join(' — ')}`;
  });

  return [
    `The saved search is: ${facts.description}.`,
    `This batch has ${scale}.`,
    '',
    'The listings, exactly as the email will print them:',
    ...lines,
  ].join('\n');
}

export type WriteAlertSummaryInput = {
  apiKey: string;
  /** Test seam, as PropertyChatInput has. A fake client never reaches network. */
  client?: Anthropic;
  facts: AlertSummaryFacts;
  track: (row: {
    model: string;
    usage: TokenUsage;
    latencyMs: number;
    entityId: string;
    userId: string;
  }) => Promise<void>;
  runId: string;
  userId: string;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
};

/**
 * One cheap call, one paragraph, no numbers.
 *
 * #4 holds here structurally rather than by instruction, in four layers:
 *
 *  1. The facts carry no bare figures — prices arrive as strings already
 *     formatted by `priceLabel`, and counts as the words "a single" or
 *     "several". There is nothing to compute with.
 *  2. The request has **no `tools` key at all** — not an empty array,
 *     absent. This function takes no `ToolContext`, holds no `db`, and
 *     cannot search. Its entire world is the `facts` object.
 *  3. Every figure in the finished email is rendered by the template from
 *     `run.matched` and `run.newCount`, i.e. from SQL. The model's output
 *     occupies exactly one `<p>`.
 *  4. `findFigures` rejects the output if a number appears anyway, and the
 *     caller falls back to a templated sentence.
 *
 * The prompt asks for the same thing, but the prompt is the weakest of the
 * five and is there to make the model's job clear rather than to enforce it.
 */
export async function writeAlertSummary(
  input: WriteAlertSummaryInput,
): Promise<AlertSummaryResult> {
  const model = getModel('alert-summary', input.env);
  const client = input.client ?? new Anthropic({ apiKey: input.apiKey });

  const startedAt = Date.now();

  const response = await client.messages.create(
    {
      model: model.id,
      max_tokens: model.maxTokens,
      system: [
        {
          type: 'text',
          text: ALERT_SUMMARY_V1,
          // Frozen and identical on every request, so it is worth caching.
          cache_control: { type: 'ephemeral' },
        },
      ],
      messages: [{ role: 'user', content: factsMessage(input.facts) }],
    },
    input.signal ? { signal: input.signal } : {},
  );

  const usage: TokenUsage = {
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
    ...(response.usage.cache_creation_input_tokens != null
      ? { cacheCreationInputTokens: response.usage.cache_creation_input_tokens }
      : {}),
    ...(response.usage.cache_read_input_tokens != null
      ? { cacheReadInputTokens: response.usage.cache_read_input_tokens }
      : {}),
  };

  // Metered whatever happens to the text below. #3 — the call was made and
  // it cost money, so there is a row for it even when the answer is thrown
  // away for containing a figure.
  await input.track({
    model: model.id,
    usage,
    latencyMs: Date.now() - startedAt,
    entityId: input.runId,
    userId: input.userId,
  });

  const text = response.content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('')
    .trim();

  if (!text) return { source: 'template', text: null, rejected: 'empty' };

  const figure = findFigures(text);
  if (figure) return { source: 'template', text: null, rejected: figure };

  return { source: 'model', text };
}

export { ALERT_SUMMARY_PROMPT_VERSION };
