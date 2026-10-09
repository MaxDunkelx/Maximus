import { loadConfig } from './config.js';
import { openDatabase } from './db/database.js';
import { Store } from './db/store.js';
import { loadEnvFile } from './env.js';
import { buildApp } from './http/app.js';
import { createLogger } from './log.js';
import { DemoProvider } from './providers/demo.js';
import { GrokResponsesProvider } from './providers/grok.js';
import { OpenAICompatibleProvider } from './providers/openai-compatible.js';
import { EdgeNeuralSpeaker } from './speech/edge.js';
import { createDefaultTools } from './tools/builtin.js';
import { ToolRegistry } from './tools/registry.js';

process.on('warning', (warning) => {
  if (warning.name === 'ExperimentalWarning' && warning.message.includes('SQLite')) return;
  console.warn(warning);
});

loadEnvFile();

let config: ReturnType<typeof loadConfig>;
try {
  config = loadConfig();
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Invalid configuration.');
  process.exit(1);
}

const logger = createLogger(config.logLevel);
const db = openDatabase(config.databasePath);
const store = new Store(db);
const tools = new ToolRegistry(createDefaultTools(store));
const provider =
  config.provider === 'fake'
    ? new DemoProvider()
    : config.provider === 'grok'
      ? new GrokResponsesProvider({
          apiKey: config.xaiApiKey ?? '',
          baseUrl: config.xaiBaseUrl,
          logger,
        })
      : new OpenAICompatibleProvider({
          baseUrl: config.ollamaBaseUrl,
          unavailableMessage:
            'Ollama is not running. Install it, start the Ollama app, then run: ollama pull llama3.2',
          logger,
        });

if (config.provider === 'grok' && !config.xaiApiKey) {
  logger.warn('XAI_API_KEY is not set. Chat requests will fail until it is configured.');
}

const app = buildApp({ config, store, provider, tools, logger, speaker: new EdgeNeuralSpeaker() });

const shutdown = async (signal: string) => {
  logger.info({ signal }, 'shutting down');
  await app.close();
  db.close();
  process.exit(0);
};
process.on('SIGINT', () => {
  void shutdown('SIGINT');
});
process.on('SIGTERM', () => {
  void shutdown('SIGTERM');
});

await app.listen({ host: config.host, port: config.port });
logger.info(
  { host: config.host, port: config.port, provider: config.provider, model: config.model },
  'Maximus listening',
);
