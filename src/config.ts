import path from 'node:path';

export type ReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh';
export type ProviderName = 'grok' | 'ollama' | 'fake';
export type LogLevel = 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';

export interface AppConfig {
  host: string;
  port: number;
  dataDir: string;
  databasePath: string;
  apiToken?: string;
  logLevel: LogLevel;
  provider: ProviderName;
  xaiApiKey?: string;
  xaiBaseUrl: string;
  ollamaBaseUrl: string;
  model: string;
  storeResponses: boolean;
  reasoningEffort: ReasoningEffort;
  maxOutputTokens: number;
  requestTimeoutMs: number;
  turnTimeoutMs: number;
  maxToolRounds: number;
  maxToolCalls: number;
}

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);
const LOG_LEVELS = new Set<LogLevel>(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']);
const EFFORTS = new Set<ReasoningEffort>(['low', 'medium', 'high', 'xhigh']);

export function loadConfig(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): AppConfig {
  const host = env.MAXIMUS_HOST?.trim() || '127.0.0.1';
  const apiToken = optionalText(env.MAXIMUS_API_TOKEN);
  if (!LOOPBACK.has(host) && !apiToken) {
    throw new Error('MAXIMUS_API_TOKEN is required when MAXIMUS_HOST is not loopback.');
  }

  const provider = parseProvider(env.MAXIMUS_PROVIDER);
  const xaiBaseUrl = (env.XAI_BASE_URL?.trim() || 'https://api.x.ai/v1').replace(/\/$/, '');
  const ollamaBaseUrl = (env.OLLAMA_BASE_URL?.trim() || 'http://127.0.0.1:11434/v1').replace(/\/$/, '');
  assertBaseUrl(xaiBaseUrl);
  assertBaseUrl(ollamaBaseUrl);

  const dataDir = resolveDataDir(cwd, env);
  return {
    host,
    port: integer(env, 'MAXIMUS_PORT', 8787, 1, 65535),
    dataDir,
    databasePath: path.join(dataDir, 'maximus.db'),
    ...(apiToken ? { apiToken } : {}),
    logLevel: parseEnum(env.MAXIMUS_LOG_LEVEL, LOG_LEVELS, 'info', 'MAXIMUS_LOG_LEVEL'),
    provider,
    ...(optionalText(env.XAI_API_KEY) ? { xaiApiKey: optionalText(env.XAI_API_KEY) } : {}),
    xaiBaseUrl,
    ollamaBaseUrl,
    model: configuredModel(provider, env),
    storeResponses: booleanFlag(env.MAXIMUS_STORE_RESPONSES, false, 'MAXIMUS_STORE_RESPONSES'),
    reasoningEffort: parseEnum(env.MAXIMUS_REASONING_EFFORT, EFFORTS, 'medium', 'MAXIMUS_REASONING_EFFORT'),
    maxOutputTokens: integer(env, 'MAXIMUS_MAX_OUTPUT_TOKENS', 2048, 1, 32000),
    requestTimeoutMs: integer(env, 'MAXIMUS_REQUEST_TIMEOUT_MS', 60_000, 1000, 300_000),
    turnTimeoutMs: integer(env, 'MAXIMUS_TURN_TIMEOUT_MS', 120_000, 1000, 300_000),
    maxToolRounds: integer(env, 'MAXIMUS_MAX_TOOL_ROUNDS', 8, 1, 16),
    maxToolCalls: integer(env, 'MAXIMUS_MAX_TOOL_CALLS', 12, 1, 32),
  };
}

export function resolveDataDir(cwd: string, env: NodeJS.ProcessEnv): string {
  const configured = optionalText(env.MAXIMUS_DATA_DIR);
  if (configured) return path.resolve(configured);
  if (isUnderOneDrive(cwd) && env.LOCALAPPDATA) {
    return path.join(env.LOCALAPPDATA, 'Maximus');
  }
  return path.resolve(cwd, 'data');
}

export function isUnderOneDrive(cwd: string): boolean {
  return cwd.split(/[\\/]/).some((segment) => segment.toLowerCase() === 'onedrive');
}

function optionalText(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function parseProvider(value: string | undefined): ProviderName {
  const name = value?.trim() || 'ollama';
  if (name === 'grok' || name === 'ollama' || name === 'fake') return name;
  throw new Error('MAXIMUS_PROVIDER must be ollama, grok, or fake.');
}

function configuredModel(provider: ProviderName, env: NodeJS.ProcessEnv): string {
  const explicit = env.MAXIMUS_MODEL?.trim() || (provider === 'grok' ? env.XAI_MODEL?.trim() : '');
  if (explicit) return explicit;
  if (provider === 'grok') return 'grok-4.7';
  return 'llama3.2';
}

function assertBaseUrl(value: string): void {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('XAI_BASE_URL is not a valid URL.');
  }
  const local = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
  if (parsed.protocol === 'https:') return;
  if (parsed.protocol === 'http:' && local) return;
  throw new Error('XAI_BASE_URL must use https, except for localhost.');
}

function booleanFlag(value: string | undefined, fallback: boolean, name: string): boolean {
  if (value === undefined || value.trim() === '') return fallback;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`${name} must be true or false.`);
}

function integer(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}.`);
  }
  return value;
}

function parseEnum<T extends string>(value: string | undefined, allowed: Set<T>, fallback: T, name: string): T {
  const candidate = (value?.trim() || fallback) as T;
  if (!allowed.has(candidate)) {
    throw new Error(`${name} is not a supported value.`);
  }
  return candidate;
}
