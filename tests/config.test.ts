import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { isUnderOneDrive, loadConfig, resolveDataDir } from '../src/config.js';
import { loadEnvFile } from '../src/env.js';
import { estimateCostUsd } from '../src/providers/pricing.js';

describe('configuration', () => {
  it('uses safe defaults and does not echo secrets in startup errors', () => {
    const config = loadConfig({}, 'C:\\work\\maximus');
    expect(config.model).toBe('llama3.2');
    expect(config.provider).toBe('ollama');
    expect(config.ollamaBaseUrl).toBe('http://127.0.0.1:11434/v1');
    expect(config.storeResponses).toBe(false);
    expect(config.host).toBe('127.0.0.1');

    expect(() => loadConfig({ MAXIMUS_HOST: '0.0.0.0', XAI_API_KEY: 'super-secret-value' }, 'C:\\work\\maximus')).toThrow(
      /MAXIMUS_API_TOKEN/,
    );
    try {
      loadConfig({ MAXIMUS_HOST: '0.0.0.0', XAI_API_KEY: 'super-secret-value' }, 'C:\\work\\maximus');
    } catch (error) {
      expect(String(error)).not.toContain('super-secret-value');
    }
  });

  it('keeps the database outside OneDrive unless a directory is configured', () => {
    expect(isUnderOneDrive('C:\\Users\\maxim\\OneDrive\\Maximus\\Maximus')).toBe(true);
    expect(
      resolveDataDir('C:\\Users\\maxim\\OneDrive\\Maximus\\Maximus', { LOCALAPPDATA: 'C:\\Users\\maxim\\AppData\\Local' }),
    ).toBe(path.join('C:\\Users\\maxim\\AppData\\Local', 'Maximus'));
    expect(resolveDataDir('C:\\work\\maximus', {})).toBe(path.resolve('C:\\work\\maximus', 'data'));
  });

  it('rejects insecure remote provider URLs', () => {
    expect(() => loadConfig({ XAI_BASE_URL: 'http://example.com' }, 'C:\\work\\maximus')).toThrow(/https/);
  });

  it('loads a dotenv file without overriding existing values', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'maximus-env-'));
    const file = path.join(directory, '.env');
    fs.writeFileSync(file, '# comment\nexport XAI_MODEL=grok-4.7\nALREADY=from-file\n');
    const env: NodeJS.ProcessEnv = { ALREADY: 'from-env' };
    loadEnvFile(file, env);
    expect(env.XAI_MODEL).toBe('grok-4.7');
    expect(env.ALREADY).toBe('from-env');
    loadEnvFile(path.join(directory, 'missing.env'), env);
  });
});

describe('pricing', () => {
  it('estimates grok-4.7 short-context cost and refuses unknown models', () => {
    expect(estimateCostUsd('grok-4.7', { inputTokens: 1_000, outputTokens: 1_000, cachedInputTokens: 250 })).toBe(0.007625);
    expect(estimateCostUsd('other-model', { inputTokens: 10, outputTokens: 10 })).toBeNull();
  });
});
