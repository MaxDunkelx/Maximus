import { randomUUID } from 'node:crypto';
import { isRecord, truncate } from '../util.js';
import { assistantTextResult, functionCallResult } from './results.js';
import type { ChatProvider, CompletionRequest, ProviderStreamEvent } from './types.js';

/** Deterministic local provider for UI checks when no API key is configured. */
export class DemoProvider implements ChatProvider {
  async *stream(request: CompletionRequest): AsyncIterable<ProviderStreamEvent> {
    const outputs = toolOutputsAfterLastUser(request.input);
    if (outputs.length > 0) {
      yield* emit(assistantTextResult(`Done. ${truncate(outputs.join('\n'), 500)}`));
      return;
    }

    const text = lastUserText(request.input);
    if (/\b(time|clock)\b/i.test(text)) {
      yield* emit(functionCallResult([{ name: 'clock_now', arguments: {}, callId: randomUUID() }]));
      return;
    }
    if (/^note:\s*/i.test(text) || /\b(save|create|make) a note\b/i.test(text)) {
      const body = text.replace(/^note:\s*/i, '').trim() || text;
      const title = body.split('\n')[0]?.slice(0, 80) || 'Note';
      yield* emit(
        functionCallResult([{ name: 'notes_create', arguments: { title, body }, callId: randomUUID() }]),
      );
      return;
    }
    const search = text.match(/\b(?:search|find) notes(?: for)?\s+(.+)$/i);
    if (/\b(?:search|find) notes\b/i.test(text)) {
      const query = search?.[1]?.trim();
      if (!query) {
        yield* emit(assistantTextResult('What should I search your notes for?'));
        return;
      }
      yield* emit(functionCallResult([{ name: 'notes_search', arguments: { query }, callId: randomUUID() }]));
      return;
    }
    yield* emit(assistantTextResult(`I can help with that. You said: ${truncate(text, 400)}`));
  }
}

async function* emit(result: ReturnType<typeof assistantTextResult>): AsyncIterable<ProviderStreamEvent> {
  if (result.text) yield { type: 'text', text: result.text };
  yield { type: 'completed', result };
}

function lastUserText(input: unknown[]): string {
  let text = '';
  for (const item of input) {
    if (isRecord(item) && item.role === 'user' && typeof item.content === 'string') text = item.content;
  }
  return text;
}

function toolOutputsAfterLastUser(input: unknown[]): string[] {
  let start = 0;
  input.forEach((item, index) => {
    if (isRecord(item) && item.role === 'user') start = index + 1;
  });
  const outputs: string[] = [];
  for (const item of input.slice(start)) {
    if (isRecord(item) && item.type === 'function_call_output' && typeof item.output === 'string') {
      outputs.push(item.output);
    }
  }
  return outputs;
}
