import http from 'http';
import { HealthStatus } from '../types';
import { logger } from '../utils/logger';

/**
 * Snapshot of runtime state used to compute readiness.
 */
export interface HealthSnapshot {
  whatsappConnected: boolean;
  aiServiceConnected: boolean;
  webSocketClients: number;
  totalChats: number;
  totalMessages: number;
}

export type HealthProvider = () => HealthSnapshot | null;

/**
 * Lightweight HTTP server exposing liveness and readiness probes.
 *
 * - GET /health (alias /healthz): liveness, always 200 while the process runs.
 * - GET /ready  (alias /readyz):  readiness, 200 only when dependencies are up.
 */
export class HealthService {
  private server: http.Server | null = null;
  private readonly startedAt: number = Date.now();

  constructor(
    private readonly port: number,
    private readonly provider: HealthProvider
  ) {}

  /**
   * Start listening for probe requests.
   */
  start(): void {
    if (this.server) {
      return;
    }

    this.server = http.createServer((req, res) => this.handleRequest(req, res));

    this.server.on('error', (error: Error) => {
      logger.error('Health server error', { error: error.message });
    });

    this.server.listen(this.port, () => {
      logger.info('Health server started', { port: this.port });
    });
  }

  /**
   * Stop the probe server.
   */
  stop(): void {
    if (this.server) {
      this.server.close();
      this.server = null;
      logger.info('Health server closed');
    }
  }

  /**
   * Build the current health payload (exposed for testing and reuse).
   */
  buildStatus(): HealthStatus {
    const snapshot = this.safeSnapshot();
    const memory = process.memoryUsage();

    const ready = Boolean(
      snapshot?.whatsappConnected && snapshot?.aiServiceConnected
    );

    return {
      status: ready ? 'healthy' : 'unhealthy',
      uptime: Math.round((Date.now() - this.startedAt) / 1000),
      memory: {
        rss: memory.rss,
        heapTotal: memory.heapTotal,
        heapUsed: memory.heapUsed,
        external: memory.external,
      },
      connections: snapshot?.webSocketClients ?? 0,
    };
  }

  /**
   * True when all critical dependencies are connected.
   */
  isReady(): boolean {
    const snapshot = this.safeSnapshot();
    return Boolean(snapshot?.whatsappConnected && snapshot?.aiServiceConnected);
  }

  private handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): void {
    const path = (req.url || '/').split('?')[0];

    if (req.method !== 'GET') {
      this.sendJson(res, 405, { error: 'method not allowed' });
      return;
    }

    switch (path) {
      case '/health':
      case '/healthz':
        // Liveness: the event loop is responding, so the process is alive.
        this.sendJson(res, 200, {
          status: 'alive',
          uptime: this.buildStatus().uptime,
        });
        return;
      case '/ready':
      case '/readyz': {
        const status = this.buildStatus();
        const snapshot = this.safeSnapshot();
        this.sendJson(res, this.isReady() ? 200 : 503, {
          ...status,
          dependencies: {
            whatsapp: Boolean(snapshot?.whatsappConnected),
            ai: Boolean(snapshot?.aiServiceConnected),
          },
          chats: snapshot?.totalChats ?? 0,
          messages: snapshot?.totalMessages ?? 0,
        });
        return;
      }
      default:
        this.sendJson(res, 404, { error: 'not found' });
    }
  }

  private safeSnapshot(): HealthSnapshot | null {
    try {
      return this.provider();
    } catch (error) {
      logger.error('Health provider failed', {
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      return null;
    }
  }

  private sendJson(
    res: http.ServerResponse,
    statusCode: number,
    body: unknown
  ): void {
    const payload = JSON.stringify({
      ...(body as object),
      timestamp: Date.now(),
    });
    res.writeHead(statusCode, { 'Content-Type': 'application/json' });
    res.end(payload);
  }
}
