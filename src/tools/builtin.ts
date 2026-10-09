import { z } from 'zod';
import type { Store } from '../db/store.js';
import type { ToolManifest } from './types.js';

const objectSchema = {
  type: 'object',
  additionalProperties: false,
} as const;

export function createDefaultTools(store: Store): ToolManifest[] {
  return [
    {
      name: 'clock_now',
      description: 'Read the current local date and time. Use this instead of guessing the time.',
      risk: 'read_only',
      idempotent: true,
      timeoutMs: 2000,
      parameters: {
        ...objectSchema,
        properties: {},
        required: [],
      },
      schema: z.strictObject({}),
      execute: async (_args, context) => ({
        iso: context.now.toISOString(),
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        epochMs: context.now.getTime(),
      }),
    },
    {
      name: 'notes_create',
      description: 'Save a note in the user\'s local notebook.',
      risk: 'low_risk_write',
      idempotent: false,
      timeoutMs: 5000,
      parameters: {
        ...objectSchema,
        properties: {
          title: { type: 'string', description: 'Short note title' },
          body: { type: 'string', description: 'Note body' },
        },
        required: ['title', 'body'],
      },
      schema: z.strictObject({
        title: z.string().trim().min(1).max(200),
        body: z.string().trim().min(1).max(20_000),
      }),
      execute: async (args, context) => {
        const parsed = args as { title: string; body: string };
        const note = store.createNote(parsed.title, parsed.body, context.now);
        return { ok: true, note: { id: note.id, title: note.title, createdAt: note.createdAt } };
      },
    },
    {
      name: 'notes_search',
      description: 'Search the user\'s local notes by title or body.',
      risk: 'read_only',
      idempotent: true,
      timeoutMs: 5000,
      parameters: {
        ...objectSchema,
        properties: {
          query: { type: 'string', description: 'Text to search for' },
        },
        required: ['query'],
      },
      schema: z.strictObject({
        query: z.string().trim().min(1).max(200),
      }),
      execute: async (args) => {
        const parsed = args as { query: string };
        const notes = store.searchNotes(parsed.query, 10);
        return { notes };
      },
    },
  ];
}
