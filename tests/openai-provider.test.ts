import { describe, expect, it, vi } from 'vitest';
import { OpenAICompatibleProvider, toChatMessages } from '../src/providers/openai-compatible.js';
import type { CompletionRequest } from '../src/providers/types.js';
import { silentLogger } from '../src/providers/types.js';

const request: CompletionRequest = {
  model: 'llama3.2',
  instructions: 'You are Maximus.',
  input: [{ role: 'user', content: 'What time is it?' }],
  tools: [
    {
      name: 'clock_now',
      description: 'Read the time',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  ],
  maxOutputTokens: 128,
  reasoningEffort: 'medium',
  storeResponses: false,
  conversationId: 'conversation-1',
  correlationId: 'correlation-1',
  signal: new AbortController().signal,
  timeoutMs: 5000,
};

describe('OpenAI-compatible provider', () => {
  it('converts tool transcripts into chat messages', () => {
    const messages = toChatMessages('You are Maximus.', [
      { role: 'user', content: 'Time?' },
      { type: 'function_call', name: 'clock_now', arguments: '{}', call_id: 'call_1' },
      { type: 'function_call_output', call_id: 'call_1', output: '{"iso":"noon"}' },
    ]);
    expect(messages[0]).toEqual({ role: 'system', content: 'You are Maximus.' });
    expect(messages[1]).toEqual({ role: 'user', content: 'Time?' });
    expect(messages[2]?.tool_calls?.[0]?.function.name).toBe('clock_now');
    expect(messages[3]).toMatchObject({ role: 'tool', tool_call_id: 'call_1' });
  });

  it('streams chat text and assembles tool calls', async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { tools: unknown[]; messages: unknown[] };
      expect(body.tools).toHaveLength(1);
      expect(body.messages[0]).toMatchObject({ role: 'system' });
      return sseResponse();
    });
    const provider = new OpenAICompatibleProvider({
      baseUrl: 'http://127.0.0.1:11434/v1',
      unavailableMessage: 'Ollama is not running.',
      fetchImpl: fetchImpl as typeof fetch,
      logger: silentLogger,
    });
    const events = [];
    for await (const event of provider.stream(request)) events.push(event);
    expect(events[0]).toEqual({ type: 'text', text: 'Checking.' });
    expect(events.at(-1)).toMatchObject({
      type: 'completed',
      result: {
        text: 'Checking.',
        toolCalls: [{ callId: 'call_1', name: 'clock_now', argumentsJson: '{}' }],
      },
    });
  });

  it('reports a down local server without retrying forever', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('connect ECONNREFUSED');
    });
    const provider = new OpenAICompatibleProvider({
      baseUrl: 'http://127.0.0.1:11434/v1',
      unavailableMessage: 'Ollama is not running.',
      fetchImpl: fetchImpl as typeof fetch,
      sleep: async () => {},
      logger: silentLogger,
    });
    await expect(drain(provider)).rejects.toMatchObject({ message: 'Ollama is not running.' });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });
});

function sseResponse(): Response {
  const chunks = [
    { choices: [{ delta: { content: 'Checking.' }, finish_reason: null }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'clock_now', arguments: '{}' } }] }, finish_reason: 'tool_calls' }] },
  ];
  const body = chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n';
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

async function drain(provider: OpenAICompatibleProvider): Promise<void> {
  for await (const _event of provider.stream(request)) {
    // Drain until the provider fails.
  }
}
