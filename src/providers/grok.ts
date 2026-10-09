import { AppError, isAbortError } from '../errors.js';
import { isRecord } from '../util.js';
import { consumeSseBuffer, finishSseBuffer, interpretFrame, type SseFrame } from './sse.js';
import type {
  ChatProvider,
  CompletionRequest,
  CompletionResult,
  FinishReason,
  NormalizedToolCall,
  ProviderLogger,
  ProviderStreamEvent,
  TokenUsage,
} from './types.js';
import { silentLogger } from './types.js';

export interface GrokProviderOptions {
  apiKey: string;
  baseUrl: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  maxRetries?: number;
  logger?: ProviderLogger;
}

export class GrokResponsesProvider implements ChatProvider {
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  private readonly maxRetries: number;
  private readonly logger: ProviderLogger;

  constructor(private readonly options: GrokProviderOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sleep = options.sleep ?? delay;
    this.maxRetries = options.maxRetries ?? 2;
    this.logger = options.logger ?? silentLogger;
  }

  async *stream(request: CompletionRequest): AsyncIterable<ProviderStreamEvent> {
    if (!this.options.apiKey) {
      throw new AppError(
        'provider_not_configured',
        'XAI_API_KEY is not set. Add it to the environment or .env file.',
        503,
      );
    }

    const started = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new DOMException('Timeout', 'TimeoutError')), request.timeoutMs);
    const onAbort = () => controller.abort(request.signal.reason);
    if (request.signal.aborted) onAbort();
    else request.signal.addEventListener('abort', onAbort, { once: true });

    try {
      const response = await this.requestWithRetry(request, controller.signal);
      const contentType = response.headers.get('content-type') ?? '';
      if (contentType.includes('application/json')) {
        const payload: unknown = await response.json();
        if (!isRecord(payload)) {
          throw new AppError('provider_incomplete', 'The AI provider returned an unreadable response.', 502);
        }
        const result = normalizeResponse(payload);
        if (result.text) yield { type: 'text', text: result.text };
        this.logCompletion(request, result, started);
        yield { type: 'completed', result };
        return;
      }

      if (!response.body) {
        throw new AppError('provider_incomplete', 'The AI provider returned an empty stream.', 502);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let completed: CompletionResult | undefined;
      const take = (frame: SseFrame): string | undefined => {
        const interpreted = interpretFrame(frame);
        if (interpreted.kind === 'delta') return interpreted.text;
        if (interpreted.kind === 'error') throw new AppError('provider_unavailable', interpreted.message, 502);
        if (interpreted.kind === 'completed') completed = normalizeResponse(interpreted.response);
        return undefined;
      };
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        const consumed = consumeSseBuffer(buffer);
        buffer = consumed.rest;
        for (const frame of consumed.frames) {
          const text = take(frame);
          if (text) yield { type: 'text', text };
        }
      }
      for (const frame of finishSseBuffer(buffer)) {
        const text = take(frame);
        if (text) yield { type: 'text', text };
      }

      if (!completed) {
        throw new AppError('provider_incomplete', 'The model stream ended before a complete response.', 502);
      }
      this.logCompletion(request, completed, started);
      yield { type: 'completed', result: completed };
    } finally {
      clearTimeout(timeout);
      request.signal.removeEventListener('abort', onAbort);
    }
  }

  private async requestWithRetry(request: CompletionRequest, signal: AbortSignal): Promise<Response> {
    let attempt = 0;
    while (true) {
      try {
        const response = await this.send(request, signal);
        if (response.ok) return response;
        const retryable = response.status === 429 || response.status >= 500;
        const retryAfter = response.headers.get('retry-after');
        await drain(response);
        if (!retryable || attempt >= this.maxRetries) {
          throw providerStatusError(response.status);
        }
        this.logger.warn(
          { correlationId: request.correlationId, status: response.status, attempt },
          'retrying provider request',
        );
        await this.sleep(backoffMs(attempt, retryAfter), signal);
        attempt += 1;
      } catch (error) {
        if (error instanceof AppError) throw error;
        if (isAbortError(error)) {
          if (request.signal.aborted) throw error;
          throw new AppError('provider_unavailable', 'The AI provider timed out.', 502);
        }
        if (signal.aborted) throw error;
        if (attempt >= this.maxRetries) {
          this.logger.warn({ correlationId: request.correlationId, attempt }, 'provider connection failed');
          throw new AppError('provider_unavailable', 'The AI provider could not be reached.', 502);
        }
        await this.sleep(backoffMs(attempt, null), signal);
        attempt += 1;
      }
    }
  }

  private send(request: CompletionRequest, signal: AbortSignal): Promise<Response> {
    const tools = request.tools.map((tool) => ({
      type: 'function',
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    }));

    const body: Record<string, unknown> = {
      model: request.model,
      instructions: request.instructions,
      input: request.input,
      store: request.storeResponses,
      prompt_cache_key: request.conversationId,
      max_output_tokens: request.maxOutputTokens,
      reasoning_effort: request.reasoningEffort,
      stream: true,
    };
    if (tools.length > 0) {
      body.tools = tools;
      body.tool_choice = 'auto';
      body.parallel_tool_calls = true;
    }

    return this.fetchImpl(`${this.options.baseUrl}/responses`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.options.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
      signal,
    });
  }

  private logCompletion(request: CompletionRequest, result: CompletionResult, started: number): void {
    this.logger.info(
      {
        correlationId: request.correlationId,
        conversationId: request.conversationId,
        model: request.model,
        finishReason: result.finishReason,
        toolNames: result.toolCalls.map((call) => call.name),
        inputTokens: result.usage?.inputTokens,
        outputTokens: result.usage?.outputTokens,
        latencyMs: Date.now() - started,
      },
      'provider response completed',
    );
  }
}

export function normalizeResponse(response: Record<string, unknown>): CompletionResult {
  const output = Array.isArray(response.output) ? response.output : [];
  const status = typeof response.status === 'string' ? response.status : 'completed';
  const usage = usageFrom(response);
  return {
    providerResponseId: typeof response.id === 'string' ? response.id : 'unknown',
    finishReason: finishReason(status),
    text: extractText(output),
    toolCalls: extractToolCalls(output),
    outputItems: output,
    ...(usage ? { usage } : {}),
  };
}

function finishReason(status: string): FinishReason {
  if (status === 'completed' || status === 'incomplete' || status === 'failed' || status === 'cancelled') return status;
  return 'failed';
}

function extractText(output: unknown[]): string {
  const parts: string[] = [];
  for (const item of output) {
    if (!isRecord(item) || item.type !== 'message' || !Array.isArray(item.content)) continue;
    for (const part of item.content) {
      if (isRecord(part) && part.type === 'output_text' && typeof part.text === 'string') parts.push(part.text);
    }
  }
  return parts.join('');
}

function extractToolCalls(output: unknown[]): NormalizedToolCall[] {
  const calls: NormalizedToolCall[] = [];
  output.forEach((item, index) => {
    if (!isRecord(item) || item.type !== 'function_call') return;
    const name = typeof item.name === 'string' && item.name ? item.name : 'invalid_tool';
    const callId = typeof item.call_id === 'string' && item.call_id ? item.call_id : `missing_${index}`;
    let argumentsJson = '{}';
    if (typeof item.arguments === 'string') argumentsJson = item.arguments;
    else if (item.arguments !== undefined) argumentsJson = JSON.stringify(item.arguments);
    calls.push({ callId, name, argumentsJson });
  });
  return calls;
}

function usageFrom(response: Record<string, unknown>): TokenUsage | undefined {
  if (!isRecord(response.usage)) return undefined;
  const usage = response.usage;
  const inputTokens = numberOrUndefined(usage.input_tokens);
  const outputTokens = numberOrUndefined(usage.output_tokens);
  if (inputTokens === undefined && outputTokens === undefined) return undefined;
  const details = isRecord(usage.input_tokens_details) ? usage.input_tokens_details : undefined;
  const promptDetails = isRecord(usage.prompt_tokens_details) ? usage.prompt_tokens_details : undefined;
  const cached = numberOrUndefined(details?.cached_tokens) ?? numberOrUndefined(promptDetails?.cached_tokens);
  return {
    inputTokens: inputTokens ?? 0,
    outputTokens: outputTokens ?? 0,
    ...(cached === undefined ? {} : { cachedInputTokens: cached }),
  };
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function providerStatusError(status: number): AppError {
  if (status === 401 || status === 403) {
    return new AppError('provider_auth', 'The AI provider rejected the API key.', 502);
  }
  if (status === 429) {
    return new AppError('provider_rate_limited', 'The AI provider rate limit was reached.', 429);
  }
  if (status >= 400 && status < 500) {
    return new AppError('provider_rejected', 'The AI provider rejected the request.', 502);
  }
  return new AppError('provider_unavailable', 'The AI provider is unavailable.', 502);
}

function backoffMs(attempt: number, retryAfter: string | null): number {
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 5000);
  }
  const base = 200 * 2 ** attempt;
  const jitter = Math.floor(Math.random() * 100);
  return Math.min(base + jitter, 5000);
}

async function drain(response: Response): Promise<void> {
  try {
    await response.arrayBuffer();
  } catch {
    // Ignore a body that cannot be read. The status code is the useful signal.
  }
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
