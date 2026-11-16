import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { ingestionManager } from './server/collectors.ts';
import { yoga } from './server/schema.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function startServer() {
  const seeded = ingestionManager.seedInitialVolume(3100);
  ingestionManager.startScheduler();
  console.log(`[GraphPulse] Seeded ${seeded} multi-source records; automated collectors active.`);

  const app = express();
  const port = Number(process.env.PORT ?? 3000);

  // All client-server data communication runs strictly via GraphQL at /graphql
  app.use('/graphql', yoga);

  const isProd = process.env.NODE_ENV === 'production';
  const distPath = path.resolve(__dirname, 'dist');

  if (!isProd && fs.existsSync(path.resolve(__dirname, 'vite.config.ts'))) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else if (fs.existsSync(distPath)) {
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(port, '0.0.0.0', () => {
    console.log(`[GraphPulse] Server listening on http://0.0.0.0:${port} (GraphQL at /graphql)`);
  });
}

startServer().catch((err) => {
  console.error('[GraphPulse] Failed to start server:', err);
  process.exit(1);
});
