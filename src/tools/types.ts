import type { RiskClass } from './policy.js';

export interface ToolContext {
  signal: AbortSignal;
  correlationId: string;
  now: Date;
}

export interface ToolSchema {
  safeParse(
    data: unknown,
  ):
    | { success: true; data: unknown }
    | { success: false; error: { issues: Array<{ path: PropertyKey[]; message: string }> } };
}

export interface ToolManifest {
  name: string;
  description: string;
  risk: RiskClass;
  parameters: Record<string, unknown>;
  schema: ToolSchema;
  timeoutMs: number;
  idempotent: boolean;
  execute: (args: unknown, context: ToolContext) => Promise<unknown>;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}
