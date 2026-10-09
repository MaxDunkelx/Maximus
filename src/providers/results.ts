import { randomUUID } from 'node:crypto';
import type { CompletionResult, NormalizedToolCall } from './types.js';

export function assistantTextResult(text: string): CompletionResult {
  return {
    providerResponseId: randomUUID(),
    finishReason: 'completed',
    text,
    toolCalls: [],
    outputItems: [
      {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text }],
      },
    ],
  };
}

export function functionCallResult(
  calls: Array<{ name: string; arguments: Record<string, unknown>; callId?: string }>,
): CompletionResult {
  const toolCalls: NormalizedToolCall[] = calls.map((call) => ({
    callId: call.callId ?? randomUUID(),
    name: call.name,
    argumentsJson: JSON.stringify(call.arguments),
  }));
  return {
    providerResponseId: randomUUID(),
    finishReason: 'completed',
    text: '',
    toolCalls,
    outputItems: toolCalls.map((call) => ({
      type: 'function_call',
      name: call.name,
      arguments: call.argumentsJson,
      call_id: call.callId,
    })),
  };
}
