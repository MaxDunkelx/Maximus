import { isRecord } from '../util.js';
import type { TranscriptItem } from '../db/store.js';

export function danglingCallIds(items: TranscriptItem[]): string[] {
  const open: string[] = [];
  const closed = new Set<string>();
  for (const stored of items) {
    if (!isRecord(stored.item)) continue;
    if (stored.item.type === 'function_call' && typeof stored.item.call_id === 'string') {
      open.push(stored.item.call_id);
    }
    if (stored.item.type === 'function_call_output' && typeof stored.item.call_id === 'string') {
      closed.add(stored.item.call_id);
    }
  }
  return open.filter((callId) => !closed.has(callId));
}
