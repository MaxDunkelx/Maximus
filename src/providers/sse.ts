import { isRecord } from '../util.js';

export interface SseFrame {
  event?: string;
  data: string;
}

/** Parses a trailing event when the connection closes without a final blank line. */
export function finishSseBuffer(buffer: string): SseFrame[] {
  if (!buffer.trim()) return [];
  const padded = buffer.endsWith('\n') ? `${buffer}\n` : `${buffer}\n\n`;
  return consumeSseBuffer(padded).frames;
}

export function consumeSseBuffer(buffer: string): { frames: SseFrame[]; rest: string } {
  const normalized = buffer.replace(/\r\n/g, '\n');
  const frames: SseFrame[] = [];
  let rest = normalized;
  let boundary = rest.indexOf('\n\n');
  while (boundary !== -1) {
    const raw = rest.slice(0, boundary);
    rest = rest.slice(boundary + 2);
    const frame = parseFrame(raw);
    if (frame) frames.push(frame);
    boundary = rest.indexOf('\n\n');
  }
  return { frames, rest };
}

export type InterpretedFrame =
  | { kind: 'ignore' }
  | { kind: 'delta'; text: string }
  | { kind: 'done' }
  | { kind: 'error'; message: string }
  | { kind: 'completed'; response: Record<string, unknown> };

export function interpretFrame(frame: SseFrame): InterpretedFrame {
  const data = frame.data.trim();
  if (!data) return { kind: 'ignore' };
  if (data === '[DONE]') return { kind: 'done' };

  let parsed: unknown;
  try {
    parsed = JSON.parse(data) as unknown;
  } catch {
    return { kind: 'error', message: 'The model stream contained malformed data.' };
  }
  if (!isRecord(parsed)) return { kind: 'ignore' };
  if (parsed.object === 'chat.completion.chunk') {
    return {
      kind: 'error',
      message: 'The provider returned Chat Completions output. Maximus expects the Responses API.',
    };
  }

  const type = typeof parsed.type === 'string' ? parsed.type : frame.event;
  if (type === 'response.output_text.delta' && typeof parsed.delta === 'string') {
    return { kind: 'delta', text: parsed.delta };
  }
  if (type === 'response.completed' || type === 'response.incomplete' || type === 'response.failed') {
    const response = isRecord(parsed.response) ? parsed.response : parsed;
    return { kind: 'completed', response };
  }
  if (type === 'error' || parsed.error) {
    return { kind: 'error', message: 'The model stream failed.' };
  }
  return { kind: 'ignore' };
}

function parseFrame(raw: string): SseFrame | undefined {
  let event: string | undefined;
  const data: string[] = [];
  for (const line of raw.split('\n')) {
    if (!line || line.startsWith(':')) continue;
    if (line.startsWith('event:')) event = line.slice('event:'.length).trim();
    else if (line.startsWith('data:')) data.push(line.slice('data:'.length).trimStart());
  }
  if (data.length === 0) return undefined;
  return event ? { event, data: data.join('\n') } : { data: data.join('\n') };
}
