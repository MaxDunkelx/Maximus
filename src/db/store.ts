import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { AutonomyLevel } from '../tools/policy.js';
import { changed, isRecord, likePattern, toIso, truncate } from '../util.js';
import { withTransaction } from './database.js';

export interface Conversation {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

export interface ChatMessage {
  id: string;
  conversationId: string;
  role: 'user' | 'assistant' | 'tool';
  content: string;
  status: 'complete' | 'incomplete' | 'failed' | 'cancelled';
  createdAt: string;
}

export interface TranscriptItem {
  ordinal: number;
  kind: string;
  item: unknown;
}

export interface Note {
  id: string;
  title: string;
  body: string;
  createdAt: string;
  updatedAt: string;
}

export interface ToolExecution {
  id: string;
  conversationId: string;
  batchId: string;
  callId: string;
  ordinal: number;
  toolName: string;
  argumentsJson: string;
  risk: string;
  status: string;
  resultJson: string | null;
  createdAt: string;
  finishedAt: string | null;
}

export interface ApprovalRecord {
  id: string;
  status: string;
  conversationId: string;
  toolExecutionId: string;
  batchId: string;
  callId: string;
  toolName: string;
  argumentsJson: string;
  risk: string;
  toolStatus: string;
  resultJson: string | null;
}

export interface UsageSummary {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
}

interface ConversationRow {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
}

interface MessageRow {
  id: string;
  conversation_id: string;
  role: ChatMessage['role'];
  content: string;
  status: ChatMessage['status'];
  created_at: string;
}

interface TranscriptRow {
  ordinal: number;
  kind: string;
  item_json: string;
}

interface NoteRow {
  id: string;
  title: string;
  body: string;
  created_at: string;
  updated_at: string;
}

interface ToolRow {
  id: string;
  conversation_id: string;
  batch_id: string;
  call_id: string;
  ordinal: number;
  tool_name: string;
  arguments_json: string;
  risk: string;
  status: string;
  result_json: string | null;
  created_at: string;
  finished_at: string | null;
}

interface ApprovalRow {
  id: string;
  status: string;
  conversation_id: string;
  tool_execution_id: string;
  batch_id: string;
  call_id: string;
  tool_name: string;
  arguments_json: string;
  risk: string;
  tool_status: string;
  result_json: string | null;
}

export class Store {
  constructor(private readonly db: DatabaseSync) {}

  createConversation(title: string, now: Date): Conversation {
    const conversation: Conversation = {
      id: randomUUID(),
      title,
      createdAt: toIso(now),
      updatedAt: toIso(now),
    };
    this.db
      .prepare('INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)')
      .run(conversation.id, conversation.title, conversation.createdAt, conversation.updatedAt);
    return conversation;
  }

  getConversation(id: string): Conversation | undefined {
    const row = this.db.prepare('SELECT id, title, created_at, updated_at FROM conversations WHERE id = ?').get(id) as
      | ConversationRow
      | undefined;
    return row ? mapConversation(row) : undefined;
  }

  listConversations(limit = 50): Conversation[] {
    const rows = rowsOf<ConversationRow>(
      this.db
        .prepare('SELECT id, title, created_at, updated_at FROM conversations ORDER BY updated_at DESC LIMIT ?')
        .all(limit),
    );
    return rows.map(mapConversation);
  }

  touchConversation(id: string, now: Date): void {
    this.db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(toIso(now), id);
  }

  deleteConversation(id: string): boolean {
    this.db.exec('BEGIN');
    try {
      this.db.prepare('DELETE FROM usage_records WHERE conversation_id = ?').run(id);
      this.db.prepare('DELETE FROM audit_events WHERE conversation_id = ?').run(id);
      const result = this.db.prepare('DELETE FROM conversations WHERE id = ?').run(id);
      this.db.exec('COMMIT');
      return Number(result.changes) > 0;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  addMessage(input: {
    conversationId: string;
    role: ChatMessage['role'];
    content: string;
    status: ChatMessage['status'];
    now: Date;
  }): ChatMessage {
    const message: ChatMessage = {
      id: randomUUID(),
      conversationId: input.conversationId,
      role: input.role,
      content: input.content,
      status: input.status,
      createdAt: toIso(input.now),
    };
    this.db
      .prepare(
        'INSERT INTO messages (id, conversation_id, role, content, status, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(message.id, message.conversationId, message.role, message.content, message.status, message.createdAt);
    this.touchConversation(input.conversationId, input.now);
    return message;
  }

  listMessages(conversationId: string): ChatMessage[] {
    const rows = rowsOf<MessageRow>(
      this.db
        .prepare(
          `SELECT id, conversation_id, role, content, status, created_at
           FROM messages WHERE conversation_id = ? ORDER BY created_at ASC, rowid ASC`,
        )
        .all(conversationId),
    );
    return rows.map((row) => ({
      id: row.id,
      conversationId: row.conversation_id,
      role: row.role,
      content: row.content,
      status: row.status,
      createdAt: row.created_at,
    }));
  }

  appendTranscript(conversationId: string, items: unknown[], now: Date): void {
    if (items.length === 0) return;
    withTransaction(this.db, () => {
      const current = this.db
        .prepare('SELECT COALESCE(MAX(ordinal), -1) AS ordinal FROM transcript_items WHERE conversation_id = ?')
        .get(conversationId) as { ordinal: number };
      let ordinal = current.ordinal + 1;
      const insert = this.db.prepare(
        `INSERT INTO transcript_items (id, conversation_id, ordinal, kind, item_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      );
      const createdAt = toIso(now);
      for (const item of items) {
        insert.run(randomUUID(), conversationId, ordinal, kindOf(item), JSON.stringify(item), createdAt);
        ordinal += 1;
      }
      this.db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(createdAt, conversationId);
    });
  }

  listTranscript(conversationId: string): TranscriptItem[] {
    const rows = rowsOf<TranscriptRow>(
      this.db
        .prepare(
          'SELECT ordinal, kind, item_json FROM transcript_items WHERE conversation_id = ? ORDER BY ordinal ASC',
        )
        .all(conversationId),
    );
    return rows.map((row) => ({
      ordinal: row.ordinal,
      kind: row.kind,
      item: JSON.parse(row.item_json) as unknown,
    }));
  }

  createNote(title: string, body: string, now: Date): Note {
    const note: Note = {
      id: randomUUID(),
      title,
      body,
      createdAt: toIso(now),
      updatedAt: toIso(now),
    };
    this.db
      .prepare('INSERT INTO notes (id, title, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run(note.id, note.title, note.body, note.createdAt, note.updatedAt);
    return note;
  }

  searchNotes(query: string, limit: number): Note[] {
    const pattern = likePattern(query);
    const rows = rowsOf<NoteRow>(
      this.db
        .prepare(
          `SELECT id, title, body, created_at, updated_at FROM notes
           WHERE title LIKE ? ESCAPE '\\' OR body LIKE ? ESCAPE '\\'
           ORDER BY updated_at DESC LIMIT ?`,
        )
        .all(pattern, pattern, limit),
    );
    return rows.map(mapNote);
  }

  listNotes(limit: number): Note[] {
    const rows = rowsOf<NoteRow>(
      this.db.prepare('SELECT id, title, body, created_at, updated_at FROM notes ORDER BY updated_at DESC LIMIT ?').all(limit),
    );
    return rows.map((row) => mapNote(row, 500));
  }

  getAutonomy(): AutonomyLevel {
    const raw = this.getSetting('autonomy_level');
    if (raw === '0' || raw === '1' || raw === '2' || raw === '3') return Number(raw) as AutonomyLevel;
    return 2;
  }

  setAutonomy(level: AutonomyLevel): void {
    this.setSetting('autonomy_level', String(level));
  }

  isHidden(): boolean {
    return this.getSetting('presence') === 'hidden';
  }

  setHidden(hidden: boolean): void {
    this.setSetting('presence', hidden ? 'hidden' : 'awake');
  }

  createBatch(conversationId: string, now: Date): string {
    const id = randomUUID();
    this.db
      .prepare('INSERT INTO tool_batches (id, conversation_id, status, created_at) VALUES (?, ?, ?, ?)')
      .run(id, conversationId, 'open', toIso(now));
    return id;
  }

  transitionBatch(id: string, from: string, to: string): boolean {
    const result = this.db.prepare('UPDATE tool_batches SET status = ? WHERE id = ? AND status = ?').run(to, id, from);
    return changed(result);
  }

  cancelOpenBatches(conversationId: string): void {
    this.db
      .prepare(`UPDATE tool_batches SET status = 'cancelled' WHERE conversation_id = ? AND status IN ('open', 'awaiting_approval')`)
      .run(conversationId);
  }

  insertToolExecution(input: {
    conversationId: string;
    batchId: string;
    callId: string;
    ordinal: number;
    toolName: string;
    argumentsJson: string;
    risk: string;
    status: string;
    now: Date;
  }): ToolExecution {
    const execution: ToolExecution = {
      id: randomUUID(),
      conversationId: input.conversationId,
      batchId: input.batchId,
      callId: input.callId,
      ordinal: input.ordinal,
      toolName: input.toolName,
      argumentsJson: input.argumentsJson,
      risk: input.risk,
      status: input.status,
      resultJson: null,
      createdAt: toIso(input.now),
      finishedAt: null,
    };
    this.db
      .prepare(
        `INSERT INTO tool_executions (
          id, conversation_id, batch_id, call_id, ordinal, tool_name, arguments_json, risk, status, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        execution.id,
        execution.conversationId,
        execution.batchId,
        execution.callId,
        execution.ordinal,
        execution.toolName,
        execution.argumentsJson,
        execution.risk,
        execution.status,
        execution.createdAt,
      );
    return execution;
  }

  claimTool(id: string, from: string, to: string): boolean {
    const result = this.db.prepare('UPDATE tool_executions SET status = ? WHERE id = ? AND status = ?').run(to, id, from);
    return changed(result);
  }

  finishTool(id: string, from: string, status: string, resultJson: string, now: Date): boolean {
    const result = this.db
      .prepare(
        `UPDATE tool_executions SET status = ?, result_json = ?, finished_at = ?
         WHERE id = ? AND status = ?`,
      )
      .run(status, resultJson, toIso(now), id, from);
    return changed(result);
  }

  getToolByCallId(callId: string): ToolExecution | undefined {
    const row = this.db.prepare('SELECT * FROM tool_executions WHERE call_id = ?').get(callId) as ToolRow | undefined;
    return row ? mapTool(row) : undefined;
  }

  listBatchExecutions(batchId: string): ToolExecution[] {
    const rows = rowsOf<ToolRow>(
      this.db.prepare('SELECT * FROM tool_executions WHERE batch_id = ? ORDER BY ordinal ASC').all(batchId),
    );
    return rows.map(mapTool);
  }

  insertApproval(toolExecutionId: string, conversationId: string, now: Date): string {
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO approval_requests (id, tool_execution_id, conversation_id, status, created_at)
         VALUES (?, ?, ?, 'pending', ?)`,
      )
      .run(id, toolExecutionId, conversationId, toIso(now));
    return id;
  }

  getApproval(id: string): ApprovalRecord | undefined {
    const row = this.db
      .prepare(
        `SELECT a.id, a.status, a.conversation_id, a.tool_execution_id,
                e.batch_id, e.call_id, e.tool_name, e.arguments_json, e.risk,
                e.status AS tool_status, e.result_json
         FROM approval_requests a
         JOIN tool_executions e ON e.id = a.tool_execution_id
         WHERE a.id = ?`,
      )
      .get(id) as ApprovalRow | undefined;
    if (!row) return undefined;
    return {
      id: row.id,
      status: row.status,
      conversationId: row.conversation_id,
      toolExecutionId: row.tool_execution_id,
      batchId: row.batch_id,
      callId: row.call_id,
      toolName: row.tool_name,
      argumentsJson: row.arguments_json,
      risk: row.risk,
      toolStatus: row.tool_status,
      resultJson: row.result_json,
    };
  }

  setApprovalStatus(id: string, from: string, status: string, now: Date): boolean {
    const result = this.db
      .prepare('UPDATE approval_requests SET status = ?, resolved_at = ? WHERE id = ? AND status = ?')
      .run(status, toIso(now), id, from);
    return changed(result);
  }

  cancelApprovalForExecution(toolExecutionId: string, now: Date): void {
    this.db
      .prepare(
        `UPDATE approval_requests SET status = 'cancelled', resolved_at = ?
         WHERE tool_execution_id = ? AND status = 'pending'`,
      )
      .run(toIso(now), toolExecutionId);
  }

  recordUsage(input: {
    conversationId: string;
    correlationId: string;
    model: string;
    inputTokens: number | null;
    outputTokens: number | null;
    cachedInputTokens: number | null;
    estimatedCostUsd: number | null;
    latencyMs: number;
    now: Date;
  }): void {
    this.db
      .prepare(
        `INSERT INTO usage_records (
          id, conversation_id, correlation_id, model, input_tokens, output_tokens,
          cached_input_tokens, estimated_cost_usd, latency_ms, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        input.conversationId,
        input.correlationId,
        input.model,
        input.inputTokens,
        input.outputTokens,
        input.cachedInputTokens,
        input.estimatedCostUsd,
        input.latencyMs,
        toIso(input.now),
      );
  }

  usageSummary(): UsageSummary {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS requests,
                COALESCE(SUM(input_tokens), 0) AS input_tokens,
                COALESCE(SUM(output_tokens), 0) AS output_tokens,
                COALESCE(SUM(estimated_cost_usd), 0) AS estimated_cost_usd
         FROM usage_records`,
      )
      .get() as {
      requests: number;
      input_tokens: number;
      output_tokens: number;
      estimated_cost_usd: number;
    };
    return {
      requests: row.requests,
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      estimatedCostUsd: row.estimated_cost_usd,
    };
  }

  audit(input: {
    conversationId?: string;
    correlationId: string;
    action: string;
    toolName?: string;
    outcome: string;
    now: Date;
  }): void {
    this.db
      .prepare(
        `INSERT INTO audit_events (id, conversation_id, correlation_id, action, tool_name, outcome, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        input.conversationId ?? null,
        input.correlationId,
        input.action,
        input.toolName ?? null,
        input.outcome,
        toIso(input.now),
      );
  }

  listAudit(limit: number): Array<{
    id: string;
    conversationId: string | null;
    action: string;
    toolName: string | null;
    outcome: string;
    createdAt: string;
  }> {
    const rows = rowsOf<{
      id: string;
      conversation_id: string | null;
      action: string;
      tool_name: string | null;
      outcome: string;
      created_at: string;
    }>(
      this.db
        .prepare(
          `SELECT id, conversation_id, action, tool_name, outcome, created_at
           FROM audit_events ORDER BY created_at DESC, rowid DESC LIMIT ?`,
        )
        .all(limit),
    );
    return rows.map((row) => ({
      id: row.id,
      conversationId: row.conversation_id,
      action: row.action,
      toolName: row.tool_name,
      outcome: row.outcome,
      createdAt: row.created_at,
    }));
  }

  private getSetting(key: string): string | undefined {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value;
  }

  private setSetting(key: string, value: string): void {
    this.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }
}

function mapConversation(row: ConversationRow): Conversation {
  return { id: row.id, title: row.title, createdAt: row.created_at, updatedAt: row.updated_at };
}

function mapNote(row: NoteRow, bodyLimit = 2000): Note {
  return {
    id: row.id,
    title: row.title,
    body: truncate(row.body, bodyLimit),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapTool(row: ToolRow): ToolExecution {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    batchId: row.batch_id,
    callId: row.call_id,
    ordinal: row.ordinal,
    toolName: row.tool_name,
    argumentsJson: row.arguments_json,
    risk: row.risk,
    status: row.status,
    resultJson: row.result_json,
    createdAt: row.created_at,
    finishedAt: row.finished_at,
  };
}

function rowsOf<T>(value: unknown): T[] {
  return value as T[];
}

function kindOf(item: unknown): string {
  if (!isRecord(item)) return 'other';
  if (typeof item.type === 'string') return item.type;
  if (typeof item.role === 'string') return item.role;
  return 'other';
}
