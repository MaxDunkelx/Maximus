import { describe, expect, it, vi } from 'vitest';
import { GrokResponsesProvider } from '../src/providers/grok.js';
import { silentLogger, type CompletionRequest, type ProviderLogger } from '../src/providers/types.js';

const request: CompletionRequest = {
  model: 'grok-4.7',
  instructions: 'You are Maximus.',
  input: [{ role: 'user', content: 'private user text' }],
  tools: [],
  maxOutputTokens: 128,
  reasoningEffort: 'medium',
  storeResponses: false,
  conversationId: 'conversation-1',
  correlationId: 'correlation-1',
  signal: new AbortController().signal,
  timeoutMs: 5000,
};

describe('GrokResponsesProvider', () => {
  it('calls the Responses API without storing the response or logging the prompt', async () => {
    const logs: Array<Record<string, unknown>> = [];
    const logger: ProviderLogger = {
      info(obj) {
        logs.push(obj);
      },
      warn(obj) {
        logs.push(obj);
      },
      error(obj) {
        logs.push(obj);
      },
    };
    const fetchImpl = vi.fn(async () => sseResponse('Hello from Grok'));
    const provider = new GrokResponsesProvider({
      apiKey: 'secret-key',
      baseUrl: 'https://api.x.ai/v1',
      fetchImpl,
      logger,
    });

    const events = [];
    for await (const event of provider.stream(request)) events.push(event);
    expect(events.map((event) => event.type)).toEqual(['text', 'completed']);

    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('https://api.x.ai/v1/responses');
    expect((init?.headers as Record<string, string>).authorization).toBe('Bearer secret-key');
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(body.store).toBe(false);
    expect(body.model).toBe('grok-4.7');
    expect(body.prompt_cache_key).toBe('conversation-1');
    expect(JSON.stringify(logs)).not.toContain('secret-key');
    expect(JSON.stringify(logs)).not.toContain('private user text');
  });

  it('does not retry a rejected request and retries a server error once', async () => {
    const rejected = vi.fn(async () => new Response('no', { status: 400 }));
    const provider = new GrokResponsesProvider({
      apiKey: 'secret-key',
      baseUrl: 'https://api.x.ai/v1',
      fetchImpl: rejected,
      logger: silentLogger,
    });
    await expect(collect(provider)).rejects.toMatchObject({ code: 'provider_rejected' });
    expect(rejected).toHaveBeenCalledTimes(1);

    let attempt = 0;
    const flaky = vi.fn(async () => {
      attempt += 1;
      if (attempt === 1) return new Response('busy', { status: 500 });
      return sseResponse('Recovered');
    });
    const retried = new GrokResponsesProvider({
      apiKey: 'secret-key',
      baseUrl: 'https://api.x.ai/v1',
      fetchImpl: flaky,
      sleep: async () => {},
      logger: silentLogger,
    });
    const events = [];
    for await (const event of retried.stream(request)) events.push(event);
    expect(flaky).toHaveBeenCalledTimes(2);
    expect(events.at(-1)).toMatchObject({ type: 'completed' });
  });

  it('fails clearly when the API key is missing', async () => {
    const provider = new GrokResponsesProvider({ apiKey: '', baseUrl: 'https://api.x.ai/v1' });
    await expect(collect(provider)).rejects.toMatchObject({ code: 'provider_not_configured' });
  });
});

function sseResponse(text: string): Response {
  const body = [
    `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: text })}`,
    '',
    `data: ${JSON.stringify({
      type: 'response.completed',
      response: {
        id: 'resp_test',
        status: 'completed',
        output: [{ type: 'message', content: [{ type: 'output_text', text }] }],
        usage: { input_tokens: 4, output_tokens: 2 },
      },
    })}`,
    '',
  ].join('\n');
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

async function collect(provider: GrokResponsesProvider): Promise<void> {
  for await (const _event of provider.stream(request)) {
    // Drain the stream so a failure surfaces to the caller.
  }
}
