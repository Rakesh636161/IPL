import { createServer } from 'node:http';
import path from 'node:path';
import express from 'express';
import dotenv from 'dotenv';
import { logEvent } from './server/lib/logger.ts';

dotenv.config({ quiet: true });

function parseCliArg(flag: string): string | undefined {
  const prefix = `${flag}=`;
  for (let i = 0; i < process.argv.length; i++) {
    const arg = process.argv[i];
    if (arg === flag && i + 1 < process.argv.length) {
      return process.argv[i + 1];
    }
    if (arg.startsWith(prefix)) {
      return arg.slice(prefix.length);
    }
  }
  return undefined;
}

async function bootstrap() {
  const app = express();
  const httpServer = createServer(app);

  app.set('trust proxy', 1);
  app.use(express.json({ limit: '1mb' }));

  // Immediate lightweight health endpoint so startup probes succeed as soon as the port opens
  app.get('/api/health', (_req, res) => {
    res.json({
      status: 'ok',
      service: 'cricketverse-api',
      timestamp: new Date().toISOString(),
    });
  });

  let apiHandler: express.RequestHandler = (_req, _res, next) => next();
  let frontendHandler: express.RequestHandler = (_req, _res, next) => next();
  let viteClose: (() => Promise<void>) | null = null;

  const isProd = process.env.NODE_ENV === 'production';

  const readyPromise = (async () => {
    const [apiModule, auctionModule, socketModule, viteInstance] = await Promise.all([
      import('./server/routes/api.ts'),
      import('./server/services/auctionEngine.ts'),
      import('./server/socket/auctionSocket.ts'),
      !isProd
        ? import('vite').then(({ createServer: createViteServer }) => {
            const hmrDisabled = process.env.DISABLE_HMR === 'true';
            return createViteServer({
              server: {
                middlewareMode: true,
                allowedHosts: true,
                hmr: hmrDisabled ? false : { server: httpServer, path: '/__vite_hmr' },
                ...(hmrDisabled ? { ws: false as const, watch: null } : {}),
              },
              appType: 'spa',
            });
          })
        : Promise.resolve(null),
    ]);

    apiHandler = apiModule.apiRouter;
    socketModule.initializeAuctionSocket(httpServer);

    auctionModule
      .recoverActiveAuctions()
      .then((res) => {
        if (res.checked > 0) {
          logEvent('INFO', 'AuctionRecovery', 'Recovered active auctions on boot', res);
        }
      })
      .catch((err) => {
        logEvent('ERROR', 'AuctionRecovery', 'Boot recovery check failed', { error: String(err) });
      });

    if (viteInstance) {
      viteClose = () => viteInstance.close();
      frontendHandler = (req, res, next) => {
        viteInstance.middlewares(req, res, next);
      };
    } else {
      const staticRouter = express.Router();
      const distDir = path.resolve(process.cwd(), 'dist');
      const srcAssetsDir = path.resolve(process.cwd(), 'src/assets');
      staticRouter.use('/src/assets', express.static(srcAssetsDir));
      staticRouter.use(express.static(distDir));
      staticRouter.get('*', (_req, res) => {
        res.sendFile(path.join(distDir, 'index.html'));
      });
      frontendHandler = staticRouter;
    }

    logEvent('INFO', 'Server', 'CricketVerse API, Socket.IO, and frontend middleware ready');
  })();

  // Surface any fatal async initialization error instead of hanging silently
  readyPromise.catch((err) => {
    logEvent('ERROR', 'Server', 'Fatal initialization error', { error: String(err) });
    console.error('Fatal server initialization error:', err);
    process.exit(1);
  });

  // Queue non-health requests briefly while parallel initialization completes
  app.use((_req, _res, next) => {
    readyPromise.then(() => next(), next);
  });

  app.use('/api', (req, res, next) => apiHandler(req, res, next));
  app.use((req, res, next) => frontendHandler(req, res, next));

  const cliPort = Number(parseCliArg('--port'));
  const PORT = Number(
    (Number.isFinite(cliPort) && cliPort > 0 ? cliPort : undefined) ||
      process.env.DEFAULT_APP_PORT ||
      (process.env.PORT && process.env.PORT !== '8080' ? process.env.PORT : 3000)
  );
  const HOST = parseCliArg('--host') || '0.0.0.0';

  httpServer.on('error', (err) => {
    logEvent('ERROR', 'Server', 'HTTP server error', { error: String(err), port: PORT });
    process.exit(1);
  });

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logEvent('INFO', 'Server', `Received ${signal}, shutting down cleanly`);
    const forceTimer = setTimeout(() => process.exit(0), 1500);
    forceTimer.unref();
    Promise.allSettled([
      viteClose ? viteClose() : Promise.resolve(),
      new Promise<void>((resolve) => httpServer.close(() => resolve())),
    ]).finally(() => {
      process.exit(0);
    });
  };

  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));

  httpServer.listen(PORT, HOST, () => {
    logEvent('INFO', 'Server', `CricketVerse server listening on http://${HOST}:${PORT}`);
  });
}

bootstrap().catch((err) => {
  console.error('Fatal server startup error:', err);
  process.exit(1);
});
