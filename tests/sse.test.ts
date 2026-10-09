import { describe, expect, it } from 'vitest';
import { normalizeResponse } from '../src/providers/grok.js';
import { consumeSseBuffer, finishSseBuffer, interpretFrame } from '../src/providers/sse.js';

describe('responses stream parsing', () => {
  it('reads text deltas and the completed response', () => {
    const raw = [
      'event: response.output_text.delta',
      'data: {"type":"response.output_text.delta","delta":"Hello"}',
      '',
      'data: {"type":"response.completed","response":{"id":"resp_1","status":"completed","output":[{"type":"message","content":[{"type":"output_text","text":"Hello"}]}],"usage":{"input_tokens":3,"output_tokens":1,"input_tokens_details":{"cached_tokens":1}}}}',
      '',
      'data: [DONE]',
      '',
    ].join('\n');
    const { frames, rest } = consumeSseBuffer(raw);
    const finished = [...frames, ...finishSseBuffer(rest)];
    expect(finished).toHaveLength(3);
    const framesToRead = finished;
    expect(interpretFrame(framesToRead[0]!).kind).toBe('delta');
    const completed = interpretFrame(framesToRead[1]!);
    expect(completed.kind).toBe('completed');
    if (completed.kind !== 'completed') return;
    const result = normalizeResponse(completed.response);
    expect(result.text).toBe('Hello');
    expect(result.usage).toEqual({ inputTokens: 3, outputTokens: 1, cachedInputTokens: 1 });
    expect(interpretFrame(framesToRead[2]!).kind).toBe('done');
  });

  it('rejects chat-completions chunks and extracts function calls', () => {
    const wrong = interpretFrame({ data: '{"object":"chat.completion.chunk","choices":[]}' });
    expect(wrong.kind).toBe('error');
    const result = normalizeResponse({
      id: 'resp_2',
      status: 'completed',
      output: [{ type: 'function_call', name: 'clock_now', arguments: '{}', call_id: 'call_1' }],
    });
    expect(result.toolCalls).toEqual([{ callId: 'call_1', name: 'clock_now', argumentsJson: '{}' }]);
  });
});
