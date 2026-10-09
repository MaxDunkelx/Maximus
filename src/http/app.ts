import { randomUUID, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppConfig } from '../config.js';
import type { Store } from '../db/store.js';
import { AppError, isAppError } from '../errors.js';
import type { Logger } from '../log.js';
import { Orchestrator, type TurnEvent } from '../orchestration/engine.js';
import { probeChatProvider } from '../providers/openai-compatible.js';
import type { ChatProvider } from '../providers/types.js';
import type { SpeechSynthesizer } from '../speech/types.js';
import type { ToolRegistry } from '../tools/registry.js';
import { formatIssues } from '../util.js';

declare module 'fastify' {
  interface FastifyRequest {
    correlationId: string;
  }
}

const uuid = z.uuid();

const STATIC_FILES: Record<string, { file: string; type: string }> = {
  '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/index.html': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/app.css': { file: 'app.css', type: 'text/css; charset=utf-8' },
  '/app.js': { file: 'app.js', type: 'text/javascript; charset=utf-8' },
  '/voice.js': { file: 'voice.js', type: 'text/javascript; charset=utf-8' },
  '/commands.js': { file: 'commands.js', type: 'text/javascript; charset=utf-8' },
};

export interface AppDeps {
  config: AppConfig;
  store: Store;
  provider: ChatProvider;
  tools: ToolRegistry;
  logger: Logger;
  speaker?: SpeechSynthesizer;
}

export function buildApp(deps: AppDeps): FastifyInstance {
  const app = Fastify({ logger: false, bodyLimit: 1_000_000 });
  const orchestrator = new Orchestrator({
    store: deps.store,
    provider: deps.provider,
    tools: deps.tools,
    logger: deps.logger,
    now: () => new Date(),
    model: deps.config.model,
    reasoningEffort: deps.config.reasoningEffort,
    maxOutputTokens: deps.config.maxOutputTokens,
    storeResponses: deps.config.storeResponses,
    requestTimeoutMs: deps.config.requestTimeoutMs,
    turnTimeoutMs: deps.config.turnTimeoutMs,
    maxToolRounds: deps.config.maxToolRounds,
    maxToolCalls: deps.config.maxToolCalls,
  });
  const publicDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../public');

  app.addHook('onRequest', async (request, reply) => {
    request.correlationId = correlationId(request.headers['x-correlation-id']);
    reply.header('x-correlation-id', request.correlationId);
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'no-referrer');
    reply.header('x-frame-options', 'DENY');
    reply.header(
      'content-security-policy',
      "default-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; media-src 'self' blob:; base-uri 'none'; frame-ancestors 'none'",
    );
    if (!isAuthorized(request, deps.config.apiToken)) {
      return reply.code(401).send(errorBody('unauthorized', 'Unauthorized.', request.correlationId));
    }
  });

  app.addHook('preHandler', async (request) => {
    if (request.method === 'GET' || request.method === 'HEAD') return;
    const pathname = request.url.split('?')[0] ?? '';
    if (pathname === '/api/presence' || !pathname.startsWith('/api/')) return;
    if (deps.store.isHidden()) throw new AppError('hidden', 'Maximus is hidden.', 409);
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof z.ZodError) {
      return reply.code(400).send(errorBody('validation_error', formatIssues(error.issues), request.correlationId));
    }
    if (isAppError(error)) {
      return reply.code(error.status).send(errorBody(error.code, error.expose ? error.message : 'The request failed.', request.correlationId));
    }
    if (isClientError(error)) {
      return reply.code(error.statusCode).send(errorBody('validation_error', 'The request could not be read.', request.correlationId));
    }
    const name = error instanceof Error ? error.name : 'Error';
    deps.logger.error({ correlationId: request.correlationId, name }, 'request failed');
    return reply.code(500).send(errorBody('internal', 'The request failed.', request.correlationId));
  });

  app.get('/api/presence', async () => ({ hidden: deps.store.isHidden() }));

  app.post('/api/presence', async (request) => {
    const body = z.object({ hidden: z.boolean() }).parse(request.body);
    deps.store.setHidden(body.hidden);
    return { hidden: body.hidden };
  });

  app.get('/api/health', async () => ({
    status: 'ok',
    service: 'maximus',
    version: '0.1.0',
    database: 'ok',
    provider: deps.config.provider,
    providerConfigured: await providerIsConfigured(deps.config),
    model: deps.config.model,
    autonomyLevel: deps.store.getAutonomy(),
  }));

  app.get('/api/settings', async () => ({ autonomyLevel: deps.store.getAutonomy() }));

  app.patch('/api/settings', async (request) => {
    const body = z.object({ autonomyLevel: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]) }).parse(request.body);
    deps.store.setAutonomy(body.autonomyLevel);
    return { autonomyLevel: body.autonomyLevel };
  });

  app.get('/api/conversations', async () => ({ conversations: deps.store.listConversations(50) }));

  app.get('/api/conversations/:id', async (request) => {
    const params = z.object({ id: uuid }).parse(request.params);
    const conversation = deps.store.getConversation(params.id);
    if (!conversation) throw new AppError('not_found', 'Conversation not found.', 404);
    return { conversation, messages: deps.store.listMessages(params.id) };
  });

  app.delete('/api/conversations/:id', async (request, reply) => {
    const params = z.object({ id: uuid }).parse(request.params);
    if (!deps.store.deleteConversation(params.id)) throw new AppError('not_found', 'Conversation not found.', 404);
    return reply.code(204).send();
  });

  app.post('/api/chat', async (request, reply) => {
    const body = z
      .object({
        conversationId: uuid.optional(),
        text: z.string().trim().min(1).max(16_000),
      })
      .parse(request.body);
    if (body.conversationId && !deps.store.getConversation(body.conversationId)) {
      throw new AppError('not_found', 'Conversation not found.', 404);
    }
    const signal = abortFrom(request);
    return sendEvents(
      reply,
      orchestrator.runTurn({
        ...(body.conversationId ? { conversationId: body.conversationId } : {}),
        text: body.text,
        signal,
        correlationId: request.correlationId,
      }),
    );
  });

  app.post('/api/approvals/:id/decision', async (request, reply) => {
    const params = z.object({ id: uuid }).parse(request.params);
    const body = z.object({ decision: z.enum(['approve', 'deny']) }).parse(request.body);
    return sendEvents(
      reply,
      orchestrator.resolveApproval({
        approvalId: params.id,
        decision: body.decision,
        signal: abortFrom(request),
        correlationId: request.correlationId,
      }),
    );
  });

  app.get('/api/notes', async () => ({ notes: deps.store.listNotes(30) }));

  app.get('/api/audit', async () => ({ events: deps.store.listAudit(50) }));

  app.get('/api/usage', async () => deps.store.usageSummary());

  app.post('/api/speech', async (request, reply) => {
    if (!deps.speaker) throw new AppError('speech_unavailable', 'The neural voice is not configured.', 503);
    const body = z.object({ text: z.string().trim().min(1).max(4_000) }).parse(request.body);
    const spoken = await deps.speaker.speak(body.text);
    return reply.header('cache-control', 'no-store').type(spoken.contentType).send(spoken.audio);
  });

  app.setNotFoundHandler(async (request, reply) => {
    if (request.method !== 'GET') throw new AppError('not_found', 'Not found.', 404);
    const pathname = request.url.split('?')[0] ?? '/';
    if (pathname === '/favicon.ico') return reply.code(204).send();
    const entry = STATIC_FILES[pathname];
    if (!entry) throw new AppError('not_found', 'Not found.', 404);
    const contents = fs.readFileSync(path.join(publicDir, entry.file));
    return reply.type(entry.type).header('cache-control', 'no-cache').send(contents);
  });

  return app;
}

function sendEvents(reply: FastifyReply, events: AsyncIterable<TurnEvent>): FastifyReply {
  const stream = Readable.from(encodeEvents(events));
  return reply
    .header('content-type', 'text/event-stream; charset=utf-8')
    .header('cache-control', 'no-cache, no-transform')
    .header('connection', 'keep-alive')
    .header('x-accel-buffering', 'no')
    .send(stream);
}

async function* encodeEvents(events: AsyncIterable<TurnEvent>): AsyncGenerator<string> {
  for await (const event of events) {
    yield `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
  }
}

function abortFrom(request: FastifyRequest): AbortSignal {
  const controller = new AbortController();
  request.raw.on('aborted', () => controller.abort());
  return controller.signal;
}

function correlationId(header: string | string[] | undefined): string {
  const value = Array.isArray(header) ? header[0] : header;
  if (value && /^[A-Za-z0-9-]{8,80}$/.test(value)) return value;
  return randomUUID();
}

function isAuthorized(request: FastifyRequest, token: string | undefined): boolean {
  if (!token) return true;
  if (request.url.split('?')[0]?.startsWith('/api/') !== true) return true;
  const header = request.headers.authorization;
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
  const presented = header.slice('Bearer '.length);
  const left = Buffer.from(presented);
  const right = Buffer.from(token);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

async function providerIsConfigured(config: AppConfig): Promise<boolean> {
  if (config.provider === 'fake') return true;
  if (config.provider === 'grok') return Boolean(config.xaiApiKey);
  return probeChatProvider(config.ollamaBaseUrl);
}

function isClientError(error: unknown): error is { statusCode: number } {
  if (typeof error !== 'object' || error === null || !('statusCode' in error)) return false;
  const statusCode = error.statusCode;
  return typeof statusCode === 'number' && statusCode >= 400 && statusCode < 500;
}

function errorBody(code: string, message: string, correlationIdValue: string) {
  return { error: { code, message, correlationId: correlationIdValue } };
}
