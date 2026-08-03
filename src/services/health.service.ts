import http from 'http';
import QRCode from 'qrcode';
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

/** Returns the latest pending WhatsApp QR string, or null. */
export type QrProvider = () => string | null;

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
    private readonly provider: HealthProvider,
    private readonly qrProvider: QrProvider | null = null
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
      case '/qr':
        void this.handleQrRequest(req, res);
        return;
      default:
        this.sendJson(res, 404, { error: 'not found' });
    }
  }

  /**
   * Serve the current WhatsApp linking QR as a scannable image, gated by the
   * QR_ACCESS_TOKEN env var. Solves the unreadable ASCII QR in platform logs.
   * The page auto-refreshes because Baileys rotates the QR periodically.
   */
  private async handleQrRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): Promise<void> {
    const requiredToken = process.env['QR_ACCESS_TOKEN'] || '';
    let providedToken = '';
    try {
      providedToken =
        new URL(req.url || '/', 'http://localhost').searchParams.get('token') ||
        '';
    } catch {
      providedToken = '';
    }

    if (requiredToken && providedToken !== requiredToken) {
      res.writeHead(401, { 'Content-Type': 'text/plain' });
      res.end('Unauthorized. Append ?token=<QR_ACCESS_TOKEN>.');
      return;
    }

    const qr = this.qrProvider ? this.qrProvider() : null;

    if (!qr) {
      this.sendHtml(
        res,
        200,
        this.qrPage(
          '<p>No QR right now. Either WhatsApp is already linked, or the connection is still starting. This page refreshes automatically.</p>'
        )
      );
      return;
    }

    try {
      const dataUrl = await QRCode.toDataURL(qr, { width: 320, margin: 2 });
      this.sendHtml(
        res,
        200,
        this.qrPage(
          `<p>Scan with WhatsApp on the bot phone: Settings &rarr; Linked Devices &rarr; Link a Device.</p>` +
            `<img src="${dataUrl}" alt="WhatsApp QR" width="320" height="320" />` +
            `<p style="color:#888">The code rotates every ~20s; this page refreshes to stay current.</p>`
        )
      );
    } catch (error) {
      logger.error('Failed to render QR image', {
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      this.sendJson(res, 500, { error: 'qr render failed' });
    }
  }

  private qrPage(body: string): string {
    return (
      '<!doctype html><html><head><meta charset="utf-8" />' +
      '<meta http-equiv="refresh" content="15" />' +
      '<meta name="viewport" content="width=device-width, initial-scale=1" />' +
      '<title>Sharh — WhatsApp QR</title></head>' +
      '<body style="font-family:system-ui,sans-serif;text-align:center;padding:24px">' +
      '<h2>WhatsApp Linking</h2>' +
      body +
      '</body></html>'
    );
  }

  private sendHtml(
    res: http.ServerResponse,
    statusCode: number,
    html: string
  ): void {
    res.writeHead(statusCode, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
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
