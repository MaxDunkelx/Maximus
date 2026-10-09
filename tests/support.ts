import { z } from 'zod';
import type { AppConfig } from '../src/config.js';
import { openDatabase } from '../src/db/database.js';
import { Store } from '../src/db/store.js';
import { createLogger } from '../src/log.js';
import { Orchestrator, type TurnEvent } from '../src/orchestration/engine.js';
import type { ChatProvider } from '../src/providers/types.js';
import { createDefaultTools } from '../src/tools/builtin.js';
import { ToolRegistry } from '../src/tools/registry.js';
import type { ToolManifest } from '../src/tools/types.js';

export function testConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    host: '127.0.0.1',
    port: 8787,
    dataDir: ':memory:',
    databasePath: ':memory:',
    logLevel: 'silent',
    provider: 'fake',
    xaiBaseUrl: 'https://api.x.ai/v1',
    model: 'grok-4.7',
    storeResponses: false,
    reasoningEffort: 'medium',
    maxOutputTokens: 256,
    requestTimeoutMs: 5000,
    turnTimeoutMs: 15000,
    maxToolRounds: 8,
    maxToolCalls: 12,
    ...overrides,
  };
}

export function createTestStore(): Store {
  return new Store(openDatabase(':memory:'));
}

export function createOrchestrator(store: Store, provider: ChatProvider, tools = new ToolRegistry(createDefaultTools(store))) {
  return new Orchestrator({
    store,
    provider,
    tools,
    logger: createLogger('silent'),
    now: () => new Date('2026-10-09T12:00:00.000Z'),
    model: 'grok-4.7',
    reasoningEffort: 'medium',
    maxOutputTokens: 256,
    storeResponses: false,
    requestTimeoutMs: 5000,
    turnTimeoutMs: 15000,
    maxToolRounds: 4,
    maxToolCalls: 6,
  });
}

export async function collect(events: AsyncIterable<TurnEvent>): Promise<TurnEvent[]> {
  const items: TurnEvent[] = [];
  for await (const event of events) items.push(event);
  return items;
}

export function consequentialTool(execute: ToolManifest['execute']): ToolManifest {
  return {
    name: 'send_mail',
    description: 'Send an email.',
    risk: 'consequential',
    idempotent: false,
    timeoutMs: 1000,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: { to: { type: 'string' } },
      required: ['to'],
    },
    schema: z.strictObject({ to: z.string().min(1) }),
    execute,
  };
}

export function destructiveTool(execute: ToolManifest['execute']): ToolManifest {
  return {
    name: 'delete_notes',
    description: 'Delete notes.',
    risk: 'destructive',
    idempotent: false,
    timeoutMs: 1000,
    parameters: { type: 'object', additionalProperties: false, properties: {}, required: [] },
    schema: z.strictObject({}),
    execute,
  };
}

export function parseSse(payload: string): Array<{ event: string; data: Record<string, unknown> }> {
  return payload
    .split('\n\n')
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => {
      let event = 'message';
      const data: string[] = [];
      for (const line of block.split('\n')) {
        if (line.startsWith('event: ')) event = line.slice('event: '.length);
        if (line.startsWith('data: ')) data.push(line.slice('data: '.length));
      }
      return { event, data: JSON.parse(data.join('\n')) as Record<string, unknown> };
    });
}
