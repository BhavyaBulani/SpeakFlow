import 'dotenv/config';
import { createApp } from './app';
import { deriveConfig, isAiConfigured, isRealtimeConfigured } from './config';
import { logger } from './lib/logger';

/**
 * Server entry point. The only file that reads .env, binds a port and installs
 * process-level handlers.
 */
function main(): void {
  const config = deriveConfig();
  const { app, services } = createApp({ config });

  if (!isAiConfigured(config)) {
    logger.warn('startup.ai_not_configured', {
      hint: 'Set OPENAI_API_KEY in .env for real replies, or MOCK_AI=1 for a labelled mock mode.',
    });
  }
  if (!isRealtimeConfigured(config)) {
    logger.warn('startup.realtime_not_configured', {
      hint: 'Live streaming transcription needs OPENAI_API_KEY. Browser speech and the Demo transcript still work.',
    });
  }
  if (config.nodeEnv === 'production' && config.accessToken === null) {
    logger.warn('startup.no_access_token', {
      hint: 'This instance is reachable without authentication. Set APP_ACCESS_TOKEN before sharing the URL.',
    });
  }

  const server = app.listen(config.port, () => {
    logger.info('startup.listening', {
      port: config.port,
      env: config.nodeEnv,
      aiConfigured: isAiConfigured(config),
      realtimeConfigured: isRealtimeConfigured(config),
      mockAi: config.mockAi,
      authRequired: config.accessToken !== null,
      replyProvider: config.aiProvider,
      replyModel: config.aiModel,
      transcribeModel: config.transcribeModel,
    });
  });

  server.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'EADDRINUSE') {
      logger.error('startup.port_in_use', { port: config.port });
    } else {
      logger.error('startup.server_error', { message: error.message });
    }
    process.exitCode = 1;
  });

  // Housekeeping: drop expired session metadata every minute.
  const sweeper = setInterval(() => {
    const removed = services.sessions.sweep();
    if (removed > 0) logger.debug('session.swept', { removed, remaining: services.sessions.size });
  }, 60_000);
  sweeper.unref();

  const shutdown = (signal: string): void => {
    logger.info('startup.shutdown', { signal });
    clearInterval(sweeper);
    server.close(() => {
      process.exit(0);
    });
    // Do not hang forever on a stuck connection.
    setTimeout(() => process.exit(0), 5_000).unref();
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main();
