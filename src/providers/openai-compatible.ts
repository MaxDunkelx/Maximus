import { randomUUID } from 'node:crypto';
import { AppError, isAbortError } from '../errors.js';
import { isRecord } from '../util.js';
import { consumeSseBuffer, finishSseBuffer, type SseFrame } from './sse.js';
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

interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: ToolCallPayload[];
  tool_call_id?: string;
}

interface ToolCallPayload {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

interface ToolAccumulator {
  id: string;
  name: string;
  arguments: string;
}

export interface OpenAICompatibleOptions {
  baseUrl: string;
  apiKey?: string;
  unavailableMessage: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  maxRetries?: number;
  logger?: ProviderLogger;
}

export class OpenAICompatibleProvider implements ChatProvider {
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  private readonly maxRetries: number;
  private readonly logger: ProviderLogger;

  constructor(private readonly options: OpenAICompatibleOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sleep = options.sleep ?? delay;
    this.maxRetries = options.maxRetries ?? 2;
    this.logger = options.logger ?? silentLogger;
  }

  async *stream(request: CompletionRequest): AsyncIterable<ProviderStreamEvent> {
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
        const result = completionFromJson(payload);
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
      const draft = emptyDraft();
      const emit = (frame: SseFrame): string | undefined => {
        const data = frame.data.trim();
        if (!data || data === '[DONE]') return undefined;
        let parsed: unknown;
        try {
          parsed = JSON.parse(data) as unknown;
        } catch {
          throw new AppError('provider_unavailable', 'The model stream contained malformed data.', 502);
        }
        return applyChatChunk(draft, parsed);
      };

      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        const consumed = consumeSseBuffer(buffer);
        buffer = consumed.rest;
        for (const frame of consumed.frames) {
          const text = emit(frame);
          if (text) yield { type: 'text', text };
        }
      }
      for (const frame of finishSseBuffer(buffer)) {
        const text = emit(frame);
        if (text) yield { type: 'text', text };
      }

      const result = draftToResult(draft);
      if (!result.text && result.toolCalls.length === 0) {
        throw new AppError('provider_incomplete', 'The model stream ended before a complete response.', 502);
      }
      this.logCompletion(request, result, started);
      yield { type: 'completed', result };
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
        if (!retryable || attempt >= this.maxRetries) throw providerStatusError(response.status);
        this.logger.warn({ correlationId: request.correlationId, status: response.status, attempt }, 'retrying provider request');
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
          throw new AppError('provider_unavailable', this.options.unavailableMessage, 502);
        }
        await this.sleep(backoffMs(attempt, null), signal);
        attempt += 1;
      }
    }
  }

  private send(request: CompletionRequest, signal: AbortSignal): Promise<Response> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.options.apiKey) headers.authorization = `Bearer ${this.options.apiKey}`;
    const tools = request.tools.map((tool) => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      },
    }));
    const body: Record<string, unknown> = {
      model: request.model,
      messages: toChatMessages(request.instructions, request.input),
      stream: true,
      max_tokens: request.maxOutputTokens,
    };
    if (tools.length > 0) body.tools = tools;
    return this.fetchImpl(`${this.options.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers,
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
        latencyMs: Date.now() - started,
      },
      'provider response completed',
    );
  }
}

export function toChatMessages(instructions: string, input: unknown[]): ChatMessage[] {
  const messages: ChatMessage[] = [{ role: 'system', content: instructions }];
  for (const item of input) {
    if (!isRecord(item)) continue;
    if (item.role === 'user' && typeof item.content === 'string') {
      messages.push({ role: 'user', content: item.content });
      continue;
    }
    if (item.role === 'assistant' && typeof item.content === 'string') {
      messages.push({ role: 'assistant', content: item.content });
      continue;
    }
    if (item.type === 'message') {
      const text = textFromMessage(item);
      if (text) messages.push({ role: 'assistant', content: text });
      continue;
    }
    if (item.type === 'function_call' && typeof item.name === 'string') {
      const call: ToolCallPayload = {
        id: typeof item.call_id === 'string' && item.call_id ? item.call_id : randomUUID(),
        type: 'function',
        function: {
          name: item.name,
          arguments: typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments ?? {}),
        },
      };
      const last = messages.at(-1);
      if (last?.role === 'assistant') last.tool_calls = [...(last.tool_calls ?? []), call];
      else messages.push({ role: 'assistant', content: null, tool_calls: [call] });
      continue;
    }
    if (item.type === 'function_call_output' && typeof item.call_id === 'string') {
      messages.push({
        role: 'tool',
        content: typeof item.output === 'string' ? item.output : JSON.stringify(item.output ?? {}),
        tool_call_id: item.call_id,
      });
    }
  }
  return messages;
}

export function completionFromJson(payload: unknown): CompletionResult {
  if (!isRecord(payload)) {
    throw new AppError('provider_incomplete', 'The AI provider returned an unreadable response.', 502);
  }
  const draft = emptyDraft();
  const choice = Array.isArray(payload.choices) ? payload.choices[0] : undefined;
  if (isRecord(choice) && isRecord(choice.message)) {
    applyMessage(draft, choice.message);
    if (typeof choice.finish_reason === 'string') draft.finish = choice.finish_reason;
  }
  applyUsage(draft, payload.usage);
  if (typeof payload.id === 'string') draft.id = payload.id;
  return draftToResult(draft);
}

function applyChatChunk(draft: Draft, payload: unknown): string | undefined {
  if (!isRecord(payload)) return undefined;
  if (typeof payload.id === 'string') draft.id = payload.id;
  applyUsage(draft, payload.usage);
  const choice = Array.isArray(payload.choices) ? payload.choices[0] : undefined;
  if (!isRecord(choice)) return undefined;
  if (typeof choice.finish_reason === 'string') draft.finish = choice.finish_reason;
  const delta = isRecord(choice.delta) ? choice.delta : isRecord(choice.message) ? choice.message : undefined;
  if (!delta) return undefined;
  let text: string | undefined;
  if (typeof delta.content === 'string' && delta.content) {
    draft.content += delta.content;
    text = delta.content;
  }
  collectToolCalls(draft, delta.tool_calls);
  return text;
}

function applyMessage(draft: Draft, message: Record<string, unknown>): void {
  if (typeof message.content === 'string') draft.content += message.content;
  collectToolCalls(draft, message.tool_calls);
}

function collectToolCalls(draft: Draft, value: unknown): void {
  if (!Array.isArray(value)) return;
  value.forEach((entry, position) => {
    if (!isRecord(entry)) return;
    const index = typeof entry.index === 'number' ? entry.index : position;
    const current = draft.tools.get(index) ?? { id: '', name: '', arguments: '' };
    if (typeof entry.id === 'string' && entry.id) current.id = entry.id;
    const fn = isRecord(entry.function) ? entry.function : undefined;
    if (fn && typeof fn.name === 'string') current.name += fn.name;
    if (fn && typeof fn.arguments === 'string') current.arguments += fn.arguments;
    draft.tools.set(index, current);
  });
}

function draftToResult(draft: Draft): CompletionResult {
  const toolCalls: NormalizedToolCall[] = [...draft.tools.entries()]
    .sort((left, right) => left[0] - right[0])
    .map(([, call]) => call)
    .filter((call) => call.name)
    .map((call) => ({
      callId: call.id || randomUUID(),
      name: call.name,
      argumentsJson: call.arguments || '{}',
    }));
  const outputItems: unknown[] = [];
  if (draft.content) {
    outputItems.push({
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: draft.content }],
    });
  }
  for (const call of toolCalls) {
    outputItems.push({
      type: 'function_call',
      name: call.name,
      arguments: call.argumentsJson,
      call_id: call.callId,
    });
  }
  return {
    providerResponseId: draft.id || 'unknown',
    finishReason: mapFinish(draft.finish),
    text: draft.content,
    toolCalls,
    outputItems,
    ...(draft.usage ? { usage: draft.usage } : {}),
  };
}

function mapFinish(finish: string | undefined): FinishReason {
  if (finish === 'length') return 'incomplete';
  if (finish === 'content_filter' || finish === 'error') return 'failed';
  return 'completed';
}

interface Draft {
  id: string;
  content: string;
  finish?: string;
  tools: Map<number, ToolAccumulator>;
  usage?: TokenUsage;
}

function emptyDraft(): Draft {
  return { id: '', content: '', tools: new Map() };
}

function applyUsage(draft: Draft, usage: unknown): void {
  if (!isRecord(usage)) return;
  const inputTokens = numberOrUndefined(usage.prompt_tokens);
  const outputTokens = numberOrUndefined(usage.completion_tokens);
  if (inputTokens === undefined && outputTokens === undefined) return;
  draft.usage = { inputTokens: inputTokens ?? 0, outputTokens: outputTokens ?? 0 };
}

function textFromMessage(item: Record<string, unknown>): string {
  if (!Array.isArray(item.content)) return '';
  return item.content
    .map((part) => (isRecord(part) && part.type === 'output_text' && typeof part.text === 'string' ? part.text : ''))
    .join('');
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function providerStatusError(status: number): AppError {
  if (status === 401 || status === 403) return new AppError('provider_auth', 'The AI provider rejected the credentials.', 502);
  if (status === 429) return new AppError('provider_rate_limited', 'The AI provider rate limit was reached.', 429);
  if (status >= 400 && status < 500) return new AppError('provider_rejected', 'The AI provider rejected the request.', 502);
  return new AppError('provider_unavailable', 'The AI provider is unavailable.', 502);
}

function backoffMs(attempt: number, retryAfter: string | null): number {
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 5000);
  }
  return Math.min(200 * 2 ** attempt + Math.floor(Math.random() * 100), 5000);
}

async function drain(response: Response): Promise<void> {
  try {
    await response.arrayBuffer();
  } catch {
    // The status code is enough.
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

export async function probeChatProvider(baseUrl: string, timeoutMs = 800): Promise<boolean> {
  const root = baseUrl.replace(/\/$/, '').replace(/\/v1$/, '');
  try {
    const response = await fetch(`${root}/api/tags`, { signal: AbortSignal.timeout(timeoutMs) });
    return response.ok;
  } catch {
    return false;
  }
}
