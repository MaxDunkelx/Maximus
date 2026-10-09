import type { ReasoningEffort } from '../config.js';
import type { ToolDefinition } from '../tools/types.js';

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
}

export interface NormalizedToolCall {
  callId: string;
  name: string;
  argumentsJson: string;
}

export type FinishReason = 'completed' | 'incomplete' | 'failed' | 'cancelled';

export interface CompletionResult {
  providerResponseId: string;
  finishReason: FinishReason;
  text: string;
  toolCalls: NormalizedToolCall[];
  outputItems: unknown[];
  usage?: TokenUsage;
}

export interface CompletionRequest {
  model: string;
  instructions: string;
  input: unknown[];
  tools: ToolDefinition[];
  maxOutputTokens: number;
  reasoningEffort: ReasoningEffort;
  storeResponses: boolean;
  conversationId: string;
  correlationId: string;
  signal: AbortSignal;
  timeoutMs: number;
}

export type ProviderStreamEvent =
  | { type: 'text'; text: string }
  | { type: 'completed'; result: CompletionResult };

export interface ChatProvider {
  stream(request: CompletionRequest): AsyncIterable<ProviderStreamEvent>;
}

export interface ProviderLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
}

export const silentLogger: ProviderLogger = {
  info() {},
  warn() {},
  error() {},
};
