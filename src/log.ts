import pino, { type LevelWithSilent, type Logger } from 'pino';

export type { Logger };

export function createLogger(level: LevelWithSilent): Logger {
  return pino({
    level,
    redact: {
      paths: [
        'req.headers.authorization',
        'authorization',
        'apiKey',
        'api_key',
        'xaiApiKey',
        'encrypted_content',
        '*.encrypted_content',
      ],
      censor: '[redacted]',
    },
  });
}
