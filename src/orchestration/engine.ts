import { AppError, publicFailure } from '../errors.js';
import type { ReasoningEffort } from '../config.js';
import type { Logger } from '../log.js';
import type { Store } from '../db/store.js';
import { estimateCostUsd } from '../providers/pricing.js';
import type { ChatProvider, CompletionResult } from '../providers/types.js';
import type { ToolRegistry } from '../tools/registry.js';
import { evaluatePolicy, type AutonomyLevel } from '../tools/policy.js';
import type { ToolManifest } from '../tools/types.js';
import { canonicalJson, encodeResult, formatIssues, titleFrom } from '../util.js';
import { IDENTITY_REPLY, PROFESSION_REPLY, SYSTEM_INSTRUCTIONS, isIdentityQuestion, isProfessionQuestion } from './instructions.js';
import { danglingCallIds } from './transcript.js';

export type TurnEvent =
  | { type: 'conversation'; conversationId: string; title: string }
  | { type: 'user_message'; messageId: string; conversationId: string }
  | { type: 'text'; text: string }
  | { type: 'tool_started'; callId: string; name: string }
  | { type: 'tool_finished'; callId: string; name: string; ok: boolean; summary: string }
  | {
      type: 'approval_required';
      approvalId: string;
      callId: string;
      name: string;
      arguments: unknown;
      risk: string;
      conversationId: string;
    }
  | { type: 'awaiting_approval'; conversationId: string }
  | { type: 'approval_recorded'; approvalId: string; conversationId: string }
  | { type: 'completed'; messageId: string; conversationId: string; text: string }
  | { type: 'failed'; code: string; message: string; conversationId?: string };

type ToolOutcome = 'paused' | 'continue' | 'stopped';

export interface OrchestratorOptions {
  store: Store;
  provider: ChatProvider;
  tools: ToolRegistry;
  logger: Logger;
  now: () => Date;
  model: string;
  reasoningEffort: ReasoningEffort;
  maxOutputTokens: number;
  storeResponses: boolean;
  requestTimeoutMs: number;
  turnTimeoutMs: number;
  maxToolRounds: number;
  maxToolCalls: number;
}

export class Orchestrator {
  constructor(private readonly options: OrchestratorOptions) {}

  async *runTurn(input: {
    conversationId?: string;
    text: string;
    signal: AbortSignal;
    correlationId: string;
  }): AsyncGenerator<TurnEvent> {
    const now = this.options.now();
    let conversationId = input.conversationId;
    let title: string;
    if (conversationId) {
      const existing = this.options.store.getConversation(conversationId);
      if (!existing) throw new AppError('not_found', 'Conversation not found.', 404);
      title = existing.title;
      this.settleDangling(conversationId, input.correlationId);
    } else {
      title = titleFrom(input.text);
      conversationId = this.options.store.createConversation(title, now).id;
    }

    yield { type: 'conversation', conversationId, title };
    const userMessage = this.options.store.addMessage({
      conversationId,
      role: 'user',
      content: input.text,
      status: 'complete',
      now,
    });
    this.options.store.appendTranscript(conversationId, [{ role: 'user', content: input.text }], now);
    yield { type: 'user_message', messageId: userMessage.id, conversationId };

    const fixed = isIdentityQuestion(input.text)
      ? IDENTITY_REPLY
      : isProfessionQuestion(input.text)
        ? PROFESSION_REPLY
        : null;
    if (fixed) {
      yield { type: 'text', text: fixed };
      const message = this.persistAssistant(conversationId, fixed, 'complete');
      yield { type: 'completed', messageId: message.id, conversationId, text: fixed };
      return;
    }

    const signal = combineSignal(input.signal, this.options.turnTimeoutMs);
    yield* this.reason(conversationId, signal, input.correlationId, 0, { count: 0 }, new Map());
  }

  async *resolveApproval(input: {
    approvalId: string;
    decision: 'approve' | 'deny';
    signal: AbortSignal;
    correlationId: string;
  }): AsyncGenerator<TurnEvent> {
    const approval = this.options.store.getApproval(input.approvalId);
    if (!approval) throw new AppError('not_found', 'Approval not found.', 404);
    if (approval.status !== 'pending') {
      throw new AppError('conflict', 'This approval was already resolved.', 409);
    }

    const signal = combineSignal(input.signal, this.options.turnTimeoutMs);
    const now = this.options.now();
    if (input.decision === 'deny') {
      const denied = this.options.store.finishTool(
        approval.toolExecutionId,
        'pending_approval',
        'denied',
        encodeResult({ error: 'The user denied this action.' }),
        now,
      );
      if (!denied) throw new AppError('conflict', 'This approval was already resolved.', 409);
      this.options.store.setApprovalStatus(approval.id, 'pending', 'denied', now);
      this.audit(approval.conversationId, input.correlationId, 'tool.denied', approval.toolName, 'denied');
      const summary = `${approval.toolName} denied`;
      this.rememberTool(approval.conversationId, summary, false);
      yield { type: 'tool_finished', callId: approval.callId, name: approval.toolName, ok: false, summary };
    } else {
      const claimed = this.options.store.claimTool(approval.toolExecutionId, 'pending_approval', 'running');
      if (!claimed) throw new AppError('conflict', 'This approval was already resolved.', 409);
      this.options.store.setApprovalStatus(approval.id, 'pending', 'approved', now);
      yield* this.executeRunning({
        executionId: approval.toolExecutionId,
        callId: approval.callId,
        name: approval.toolName,
        argumentsJson: approval.argumentsJson,
        conversationId: approval.conversationId,
        correlationId: input.correlationId,
        signal,
      });
    }

    if (this.batchHasPending(approval.batchId)) {
      yield { type: 'approval_recorded', approvalId: approval.id, conversationId: approval.conversationId };
      return;
    }
    const continued = this.options.store.transitionBatch(approval.batchId, 'awaiting_approval', 'continued');
    if (!continued) {
      yield { type: 'approval_recorded', approvalId: approval.id, conversationId: approval.conversationId };
      return;
    }
    this.appendBatchOutputs(approval.batchId, approval.conversationId);
    yield* this.reason(approval.conversationId, signal, input.correlationId, 0, { count: 0 }, new Map());
  }

  private async *reason(
    conversationId: string,
    signal: AbortSignal,
    correlationId: string,
    rounds: number,
    counter: { count: number },
    seen: Map<string, true>,
  ): AsyncGenerator<TurnEvent> {
    const allowTools = rounds < this.options.maxToolRounds && counter.count < this.options.maxToolCalls;
    const completion = yield* this.invokeModel(conversationId, signal, correlationId, allowTools);
    if (!completion) return;

    if (!allowTools) {
      const text = completion.text || 'I stopped because this request reached the tool-use limit.';
      if (!completion.text) yield { type: 'text', text };
      const message = this.persistAssistant(conversationId, text, 'failed');
      yield { type: 'completed', messageId: message.id, conversationId, text };
      return;
    }

    if (completion.finishReason !== 'completed') {
      if (completion.text) this.persistAssistant(conversationId, completion.text, 'incomplete');
      yield {
        type: 'failed',
        code: 'provider_incomplete',
        message: 'The model response was interrupted.',
        conversationId,
      };
      return;
    }

    if (completion.toolCalls.length > 32) {
      this.appendTooManyCalls(conversationId, completion);
      yield {
        type: 'failed',
        code: 'tool_call_limit',
        message: 'The model requested too many tools at once, so none were executed.',
        conversationId,
      };
      return;
    }

    this.options.store.appendTranscript(conversationId, acceptedItems(completion), this.options.now());
    if (completion.toolCalls.length === 0) {
      const text = completion.text || 'I do not have a response for that.';
      if (!completion.text) yield { type: 'text', text };
      const message = this.persistAssistant(conversationId, text, 'complete', completion.outputItems.length === 0);
      yield { type: 'completed', messageId: message.id, conversationId, text };
      return;
    }

    if (completion.text) {
      this.options.store.addMessage({
        conversationId,
        role: 'assistant',
        content: completion.text,
        status: 'complete',
        now: this.options.now(),
      });
    }

    const outcome = yield* this.runTools(conversationId, completion, signal, correlationId, counter, seen);
    if (outcome !== 'continue') return;
    yield* this.reason(conversationId, signal, correlationId, rounds + 1, counter, seen);
  }

  private async *invokeModel(
    conversationId: string,
    signal: AbortSignal,
    correlationId: string,
    allowTools: boolean,
  ): AsyncGenerator<TurnEvent, CompletionResult | null> {
    if (signal.aborted) {
      yield { type: 'failed', code: 'cancelled', message: 'Cancelled.', conversationId };
      return null;
    }

    const autonomy = this.options.store.getAutonomy();
    const tools = allowTools && autonomy > 0 ? this.options.tools.definitions() : [];
    const started = Date.now();
    let streamed = '';
    let result: CompletionResult | undefined;
    try {
      for await (const event of this.options.provider.stream({
        model: this.options.model,
        instructions: SYSTEM_INSTRUCTIONS,
        input: this.options.store.listTranscript(conversationId).map((item) => item.item),
        tools,
        maxOutputTokens: this.options.maxOutputTokens,
        reasoningEffort: this.options.reasoningEffort,
        storeResponses: this.options.storeResponses,
        conversationId,
        correlationId,
        signal,
        timeoutMs: this.options.requestTimeoutMs,
      })) {
        if (event.type === 'text') {
          streamed += event.text;
          yield { type: 'text', text: event.text };
        } else {
          result = event.result;
        }
      }
    } catch (error) {
      const failure = publicFailure(error);
      if (streamed) this.persistAssistant(conversationId, streamed, 'incomplete');
      this.options.logger.error({ correlationId, code: failure.code }, 'model request failed');
      yield { type: 'failed', code: failure.code, message: failure.message, conversationId };
      return null;
    }

    if (!result) {
      yield {
        type: 'failed',
        code: 'provider_incomplete',
        message: 'The model stream ended before a complete response.',
        conversationId,
      };
      return null;
    }

    if (result.text.startsWith(streamed)) {
      const suffix = result.text.slice(streamed.length);
      if (suffix) yield { type: 'text', text: suffix };
    }

    this.options.store.recordUsage({
      conversationId,
      correlationId,
      model: this.options.model,
      inputTokens: result.usage?.inputTokens ?? null,
      outputTokens: result.usage?.outputTokens ?? null,
      cachedInputTokens: result.usage?.cachedInputTokens ?? null,
      estimatedCostUsd: result.usage ? estimateCostUsd(this.options.model, result.usage) : null,
      latencyMs: Date.now() - started,
      now: this.options.now(),
    });
    return result;
  }

  private async *runTools(
    conversationId: string,
    completion: CompletionResult,
    signal: AbortSignal,
    correlationId: string,
    counter: { count: number },
    seen: Map<string, true>,
  ): AsyncGenerator<TurnEvent, ToolOutcome> {
    const now = this.options.now();
    const batchId = this.options.store.createBatch(conversationId, now);
    const autonomy = this.options.store.getAutonomy();
    let ordinal = 0;
    for (const call of completion.toolCalls) {
      const limited = counter.count >= this.options.maxToolCalls;
      if (!limited) counter.count += 1;
      yield* this.dispatchCall({
        conversationId,
        batchId,
        callId: call.callId,
        name: call.name,
        argumentsJson: call.argumentsJson,
        ordinal,
        autonomy,
        correlationId,
        signal,
        seen,
        limited,
      });
      ordinal += 1;
    }

    if (this.batchHasPending(batchId)) {
      this.options.store.transitionBatch(batchId, 'open', 'awaiting_approval');
      yield { type: 'awaiting_approval', conversationId };
      return 'paused';
    }
    if (!this.options.store.transitionBatch(batchId, 'open', 'continued')) return 'stopped';
    this.appendBatchOutputs(batchId, conversationId);
    return 'continue';
  }

  private async *dispatchCall(input: {
    conversationId: string;
    batchId: string;
    callId: string;
    name: string;
    argumentsJson: string;
    ordinal: number;
    autonomy: AutonomyLevel;
    correlationId: string;
    signal: AbortSignal;
    seen: Map<string, true>;
    limited: boolean;
  }): AsyncGenerator<TurnEvent> {
    const now = this.options.now();
    const tool = this.options.tools.get(input.name);
    const execution = this.options.store.insertToolExecution({
      conversationId: input.conversationId,
      batchId: input.batchId,
      callId: input.callId,
      ordinal: input.ordinal,
      toolName: input.name,
      argumentsJson: input.argumentsJson,
      risk: tool?.risk ?? 'unknown',
      status: 'running',
      now,
    });

    const fail = (summary: string, outcome: string) => {
      this.options.store.finishTool(execution.id, 'running', 'failed', encodeResult({ error: summary }), now);
      this.audit(input.conversationId, input.correlationId, 'tool.failed', input.name, outcome);
      this.rememberTool(input.conversationId, summary, false);
    };

    if (input.limited) {
      const summary = `${input.name} was not run because the tool call limit was reached.`;
      fail(summary, 'limited');
      yield { type: 'tool_finished', callId: input.callId, name: input.name, ok: false, summary };
      return;
    }
    if (!tool) {
      const summary = `Unknown tool: ${input.name}`;
      fail(summary, 'unknown');
      yield { type: 'tool_finished', callId: input.callId, name: input.name, ok: false, summary };
      return;
    }

    const parsed = parseArguments(input.argumentsJson, tool);
    if (!parsed.ok) {
      fail(parsed.summary, 'invalid_arguments');
      yield { type: 'tool_finished', callId: input.callId, name: input.name, ok: false, summary: parsed.summary };
      return;
    }

    if (!tool.idempotent) {
      const key = `${tool.name}:${canonicalJson(parsed.value)}`;
      if (input.seen.has(key)) {
        const summary = `${tool.name} was not run again because the same action already happened in this turn.`;
        fail(summary, 'duplicate');
        yield { type: 'tool_finished', callId: input.callId, name: input.name, ok: false, summary };
        return;
      }
      input.seen.set(key, true);
    }

    const decision = evaluatePolicy(tool.risk, input.autonomy);
    if (decision === 'deny') {
      const summary = `${tool.name} is not allowed at the current autonomy level.`;
      this.options.store.finishTool(execution.id, 'running', 'denied', encodeResult({ error: summary }), now);
      this.audit(input.conversationId, input.correlationId, 'tool.denied', tool.name, 'denied');
      this.rememberTool(input.conversationId, summary, false);
      yield { type: 'tool_finished', callId: input.callId, name: input.name, ok: false, summary };
      return;
    }
    if (decision === 'require_approval') {
      if (!this.options.store.claimTool(execution.id, 'running', 'pending_approval')) {
        fail('The action could not be queued for approval.', 'conflict');
        yield {
          type: 'tool_finished',
          callId: input.callId,
          name: input.name,
          ok: false,
          summary: 'The action could not be queued for approval.',
        };
        return;
      }
      const approvalId = this.options.store.insertApproval(execution.id, input.conversationId, now);
      this.audit(input.conversationId, input.correlationId, 'tool.approval_required', tool.name, 'pending');
      yield {
        type: 'approval_required',
        approvalId,
        callId: input.callId,
        name: tool.name,
        arguments: parsed.value,
        risk: tool.risk,
        conversationId: input.conversationId,
      };
      return;
    }

    yield* this.executeRunning({
      executionId: execution.id,
      callId: input.callId,
      name: tool.name,
      argumentsJson: JSON.stringify(parsed.value),
      conversationId: input.conversationId,
      correlationId: input.correlationId,
      signal: input.signal,
    });
  }

  private async *executeRunning(input: {
    executionId: string;
    callId: string;
    name: string;
    argumentsJson: string;
    conversationId: string;
    correlationId: string;
    signal: AbortSignal;
  }): AsyncGenerator<TurnEvent> {
    const tool = this.options.tools.get(input.name);
    yield { type: 'tool_started', callId: input.callId, name: input.name };
    const now = this.options.now();
    if (!tool) {
      const summary = `Unknown tool: ${input.name}`;
      this.options.store.finishTool(input.executionId, 'running', 'failed', encodeResult({ error: summary }), now);
      this.rememberTool(input.conversationId, summary, false);
      yield { type: 'tool_finished', callId: input.callId, name: input.name, ok: false, summary };
      return;
    }

    const parsed = parseArguments(input.argumentsJson, tool);
    if (!parsed.ok) {
      this.options.store.finishTool(
        input.executionId,
        'running',
        'failed',
        encodeResult({ error: parsed.summary }),
        now,
      );
      this.rememberTool(input.conversationId, parsed.summary, false);
      yield { type: 'tool_finished', callId: input.callId, name: input.name, ok: false, summary: parsed.summary };
      return;
    }

    try {
      const value = await runTool(tool, parsed.value, {
        signal: input.signal,
        correlationId: input.correlationId,
        now: this.options.now(),
      });
      const summary = `${tool.name} completed`;
      this.options.store.finishTool(input.executionId, 'running', 'succeeded', encodeResult(value), this.options.now());
      this.audit(input.conversationId, input.correlationId, 'tool.succeeded', tool.name, 'succeeded');
      this.rememberTool(input.conversationId, summary, true);
      yield { type: 'tool_finished', callId: input.callId, name: tool.name, ok: true, summary };
    } catch (error) {
      const failure = publicFailure(error);
      const summary = `${tool.name} failed: ${failure.message}`;
      this.options.store.finishTool(
        input.executionId,
        'running',
        'failed',
        encodeResult({ error: failure.message }),
        this.options.now(),
      );
      this.audit(input.conversationId, input.correlationId, 'tool.failed', tool.name, failure.code);
      this.options.logger.warn({ correlationId: input.correlationId, tool: tool.name, code: failure.code }, 'tool failed');
      this.rememberTool(input.conversationId, summary, false);
      yield { type: 'tool_finished', callId: input.callId, name: tool.name, ok: false, summary };
    }
  }

  private persistAssistant(
    conversationId: string,
    text: string,
    status: 'complete' | 'incomplete' | 'failed',
    includeTranscript = true,
  ) {
    const now = this.options.now();
    if (includeTranscript) {
      this.options.store.appendTranscript(conversationId, [{ role: 'assistant', content: text }], now);
    }
    return this.options.store.addMessage({
      conversationId,
      role: 'assistant',
      content: text,
      status,
      now,
    });
  }

  private appendBatchOutputs(batchId: string, conversationId: string): void {
    const outputs = this.options.store.listBatchExecutions(batchId).map((execution) => ({
      type: 'function_call_output',
      call_id: execution.callId,
      output: execution.resultJson ?? encodeResult({ error: 'No result was recorded.' }),
    }));
    this.options.store.appendTranscript(conversationId, outputs, this.options.now());
  }

  private appendTooManyCalls(conversationId: string, completion: CompletionResult): void {
    const outputs = completion.toolCalls.map((call) => ({
      type: 'function_call_output',
      call_id: call.callId,
      output: encodeResult({ error: 'Too many tool calls in one response. None were executed.' }),
    }));
    this.options.store.appendTranscript(conversationId, [...acceptedItems(completion), ...outputs], this.options.now());
  }

  private batchHasPending(batchId: string): boolean {
    return this.options.store.listBatchExecutions(batchId).some((execution) => execution.status === 'pending_approval');
  }

  private settleDangling(conversationId: string, correlationId: string): void {
    const dangling = danglingCallIds(this.options.store.listTranscript(conversationId));
    if (dangling.length === 0) return;
    const now = this.options.now();
    const interrupted = encodeResult({ error: 'Interrupted before the action finished. It was not retried.' });
    const outputs: unknown[] = [];
    for (const callId of dangling) {
      const execution = this.options.store.getToolByCallId(callId);
      if (execution?.status === 'succeeded' && execution.resultJson) {
        outputs.push({ type: 'function_call_output', call_id: callId, output: execution.resultJson });
        continue;
      }
      if (execution && (execution.status === 'pending_approval' || execution.status === 'running')) {
        this.options.store.finishTool(execution.id, execution.status, 'cancelled', interrupted, now);
        this.options.store.cancelApprovalForExecution(execution.id, now);
      }
      outputs.push({ type: 'function_call_output', call_id: callId, output: interrupted });
      this.audit(conversationId, correlationId, 'tool.cancelled', execution?.toolName, 'cancelled');
    }
    this.options.store.cancelOpenBatches(conversationId);
    this.options.store.appendTranscript(conversationId, outputs, now);
  }

  private rememberTool(conversationId: string, summary: string, ok: boolean): void {
    this.options.store.addMessage({
      conversationId,
      role: 'tool',
      content: summary,
      status: ok ? 'complete' : 'failed',
      now: this.options.now(),
    });
  }

  private audit(
    conversationId: string,
    correlationId: string,
    action: string,
    toolName: string | undefined,
    outcome: string,
  ): void {
    this.options.store.audit({
      conversationId,
      correlationId,
      action,
      ...(toolName ? { toolName } : {}),
      outcome,
      now: this.options.now(),
    });
  }
}

function acceptedItems(result: CompletionResult): unknown[] {
  if (result.outputItems.length > 0) return result.outputItems;
  if (result.text) return [{ role: 'assistant', content: result.text }];
  return [];
}

function parseArguments(
  argumentsJson: string,
  tool: ToolManifest,
): { ok: true; value: unknown } | { ok: false; summary: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(argumentsJson) as unknown;
  } catch {
    return { ok: false, summary: `${tool.name} failed: arguments were not valid JSON.` };
  }
  const checked = tool.schema.safeParse(raw);
  if (!checked.success) {
    return { ok: false, summary: `${tool.name} failed: ${formatIssues(checked.error.issues)}` };
  }
  return { ok: true, value: checked.data };
}

async function runTool(
  tool: ToolManifest,
  args: unknown,
  context: { signal: AbortSignal; correlationId: string; now: Date },
): Promise<unknown> {
  let timeoutSignal: AbortSignal;
  try {
    timeoutSignal = AbortSignal.timeout(tool.timeoutMs);
  } catch {
    timeoutSignal = context.signal;
  }
  const signal = AbortSignal.any([context.signal, timeoutSignal]);
  try {
    return await tool.execute(args, { ...context, signal });
  } catch (error) {
    if (timeoutSignal.aborted && !context.signal.aborted) {
      throw new AppError('tool_timeout', `${tool.name} timed out.`, 504);
    }
    throw error;
  }
}

function combineSignal(signal: AbortSignal, timeoutMs: number): AbortSignal {
  return AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
}
