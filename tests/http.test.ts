import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/http/app.js';
import { createLogger } from '../src/log.js';
import { assistantTextResult } from '../src/providers/results.js';
import { ScriptedProvider } from '../src/providers/scripted.js';
import { DemoProvider } from '../src/providers/demo.js';
import { createDefaultTools } from '../src/tools/builtin.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { createTestStore, parseSse, testConfig } from './support.js';

describe('http api', () => {
  it('answers a chat over SSE and serves the interface', async () => {
    const store = createTestStore();
    const app = buildApp({
      config: testConfig(),
      store,
      provider: new ScriptedProvider([() => assistantTextResult('Ready')]),
      tools: new ToolRegistry(createDefaultTools(store)),
      logger: createLogger('silent'),
    });
    const health = await app.inject({ method: 'GET', url: '/api/health' });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toMatchObject({ provider: 'fake', providerConfigured: true, model: 'grok-4.7' });

    const page = await app.inject({ method: 'GET', url: '/' });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('Maximus');
    expect(page.body).toContain('id="talk"');
    const voice = await app.inject({ method: 'GET', url: '/voice.js' });
    expect(voice.statusCode).toBe(200);
    expect(voice.body).toContain('createVoiceController');
    const commands = await app.inject({ method: 'GET', url: '/commands.js' });
    expect(commands.statusCode).toBe(200);
    expect(commands.body).toContain('voiceCommand');

    const chat = await app.inject({ method: 'POST', url: '/api/chat', payload: { text: 'Hello' } });
    expect(chat.statusCode).toBe(200);
    const events = parseSse(chat.body);
    expect(events.at(-1)?.data).toMatchObject({ type: 'completed', text: 'Ready' });
    await app.close();
  });

  it('rejects API calls without the configured token and blocks path traversal', async () => {
    const store = createTestStore();
    const app = buildApp({
      config: testConfig({ apiToken: 'local-token' }),
      store,
      provider: new DemoProvider(),
      tools: new ToolRegistry(createDefaultTools(store)),
      logger: createLogger('silent'),
    });
    const denied = await app.inject({ method: 'GET', url: '/api/health' });
    expect(denied.statusCode).toBe(401);
    const allowed = await app.inject({
      method: 'GET',
      url: '/api/health',
      headers: { authorization: 'Bearer local-token' },
    });
    expect(allowed.statusCode).toBe(200);
    const malformed = await app.inject({
      method: 'POST',
      url: '/api/chat',
      headers: { 'content-type': 'application/json', authorization: 'Bearer local-token' },
      payload: '{',
    });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.body).not.toContain('secret');
    const traversal = await app.inject({ method: 'GET', url: '/../package.json' });
    expect(traversal.statusCode).toBe(404);
    expect(traversal.body).not.toContain('xaiApiKey');
    await app.close();
  });

  it('can save a note through the demo provider', async () => {
    const store = createTestStore();
    const app = buildApp({
      config: testConfig(),
      store,
      provider: new DemoProvider(),
      tools: new ToolRegistry(createDefaultTools(store)),
      logger: createLogger('silent'),
    });
    const chat = await app.inject({ method: 'POST', url: '/api/chat', payload: { text: 'note: Buy milk' } });
    expect(chat.statusCode).toBe(200);
    expect(parseSse(chat.body).some((event) => event.event === 'completed')).toBe(true);
    expect(store.searchNotes('milk', 10).map((note) => note.title)).toContain('Buy milk');
    const started = parseSse(chat.body).find((event) => event.event === 'conversation');
    const conversationId = String(started?.data.conversationId);
    const removed = await app.inject({ method: 'DELETE', url: `/api/conversations/${conversationId}` });
    expect(removed.statusCode).toBe(204);
    const missing = await app.inject({ method: 'GET', url: `/api/conversations/${conversationId}` });
    expect(missing.statusCode).toBe(404);
    await app.close();
  });

  it('returns synthesized speech audio', async () => {
    const store = createTestStore();
    const app = buildApp({
      config: testConfig(),
      store,
      provider: new DemoProvider(),
      tools: new ToolRegistry(createDefaultTools(store)),
      logger: createLogger('silent'),
      speaker: {
        async speak(text) {
          return { audio: Buffer.from(`audio:${text}`), contentType: 'audio/mpeg' };
        },
      },
    });
    const speech = await app.inject({ method: 'POST', url: '/api/speech', payload: { text: 'Strength and honor.' } });
    expect(speech.statusCode).toBe(200);
    expect(speech.headers['content-type']).toContain('audio/mpeg');
    expect(speech.body).toContain('Strength and honor.');
    await app.close();
  });

  it('stops the service while Maximus is hidden', async () => {
    const store = createTestStore();
    const app = buildApp({
      config: testConfig(),
      store,
      provider: new ScriptedProvider([() => assistantTextResult('Ready')]),
      tools: new ToolRegistry(createDefaultTools(store)),
      logger: createLogger('silent'),
      speaker: {
        async speak(text) {
          return { audio: Buffer.from(text), contentType: 'audio/mpeg' };
        },
      },
    });
    const hidden = await app.inject({ method: 'POST', url: '/api/presence', payload: { hidden: true } });
    expect(hidden.statusCode).toBe(200);
    expect(hidden.json()).toEqual({ hidden: true });
    const chat = await app.inject({ method: 'POST', url: '/api/chat', payload: { text: 'Hello' } });
    expect(chat.statusCode).toBe(409);
    expect(chat.json().error.code).toBe('hidden');
    const speech = await app.inject({ method: 'POST', url: '/api/speech', payload: { text: 'Hello' } });
    expect(speech.statusCode).toBe(409);
    const risen = await app.inject({ method: 'POST', url: '/api/presence', payload: { hidden: false } });
    expect(risen.json()).toEqual({ hidden: false });
    const again = await app.inject({ method: 'POST', url: '/api/chat', payload: { text: 'Hello' } });
    expect(again.statusCode).toBe(200);
    await app.close();
  });
});
