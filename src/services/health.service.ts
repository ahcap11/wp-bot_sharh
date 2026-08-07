import http from 'http';
import QRCode from 'qrcode';
import { HealthStatus, MessagingTransport } from '../types';
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
  sharhApiEnabled?: boolean | undefined;
  sharhApiReachable?: boolean | null | undefined;
  sharhSyncPending?: number | undefined;
}

export type HealthProvider = () => HealthSnapshot | null;

/** Returns the latest pending WhatsApp QR string, or null. */
export type QrProvider = () => string | null;
export type VerifiedWebhookForwarder = (rawBody: Buffer) => void;

/**
 * Lightweight HTTP server exposing liveness and readiness probes.
 *
 * - GET /health (alias /healthz): liveness, always 200 while the process runs.
 * - GET /ready  (alias /readyz):  readiness, 200 only when dependencies are up.
 */
export class HealthService {
  private servers: http.Server[] = [];
  private readonly startedAt: number = Date.now();

  constructor(
    private readonly portOrPorts: number | number[],
    private readonly provider: HealthProvider,
    private readonly qrProvider: QrProvider | null = null,
    private readonly webhookTransport: MessagingTransport | null = null,
    private readonly verifiedWebhookForwarder: VerifiedWebhookForwarder | null = null
  ) {}

  /**
   * Start listening for probe requests.
   */
  start(): void {
    if (this.servers.length > 0) {
      return;
    }

    const ports = Array.from(
      new Set(
        (Array.isArray(this.portOrPorts)
          ? this.portOrPorts
          : [this.portOrPorts]
        ).filter(port => Number.isInteger(port) && port > 0)
      )
    );

    for (const port of ports) {
      const server = http.createServer((req, res) => {
        void this.handleRequest(req, res);
      });

      server.on('error', (error: Error) => {
        logger.error('Health server error', { port, error: error.message });
      });

      server.listen(port, '0.0.0.0', () => {
        logger.info('Health server started', {
          host: '0.0.0.0',
          port,
        });
      });

      this.servers.push(server);
    }
  }

  /**
   * Stop the probe server.
   */
  stop(): void {
    if (this.servers.length === 0) {
      return;
    }

    for (const server of this.servers) {
      server.close();
    }
    this.servers = [];
    logger.info('Health server closed');
  }

  /**
   * Build the current health payload (exposed for testing and reuse).
   */
  buildStatus(): HealthStatus {
    const snapshot = this.safeSnapshot();
    const memory = process.memoryUsage();

    const sharhReady = Boolean(
      !snapshot?.sharhApiEnabled || snapshot?.sharhApiReachable === true
    );
    const ready = Boolean(
      snapshot?.whatsappConnected &&
        snapshot?.aiServiceConnected &&
        sharhReady
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
    return Boolean(
      snapshot?.whatsappConnected &&
        snapshot?.aiServiceConnected &&
        (!snapshot?.sharhApiEnabled || snapshot?.sharhApiReachable === true)
    );
  }

  private async handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): Promise<void> {
    const path = (req.url || '/').split('?')[0];
    const webhookPath = this.webhookTransport?.getWebhookPath?.();

    if (webhookPath && path === webhookPath) {
      await this.handleMessagingWebhook(req, res);
      return;
    }

    if (req.method !== 'GET') {
      this.sendJson(res, 405, { error: 'method not allowed' });
      return;
    }

    switch (path) {
      case '/health':
      case '/healthz':
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
            sharh_api: snapshot?.sharhApiEnabled
              ? snapshot?.sharhApiReachable === true
              : true,
          },
          sharh_sync_pending: snapshot?.sharhSyncPending ?? 0,
          chats: snapshot?.totalChats ?? 0,
          messages: snapshot?.totalMessages ?? 0,
        });
        return;
      }
      case '/qr':
        await this.handleQrRequest(req, res);
        return;
      default:
        this.sendJson(res, 404, { error: 'not found' });
    }
  }

  private async handleMessagingWebhook(
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): Promise<void> {
    if (!this.webhookTransport) {
      this.sendJson(res, 404, { error: 'not found' });
      return;
    }

    if (req.method === 'GET') {
      const query = new URL(req.url || '/', 'http://localhost').searchParams;
      const challenge = this.webhookTransport.verifyWebhookChallenge?.(query);
      if (!challenge) {
        this.sendText(res, 403, 'Forbidden');
        return;
      }
      this.sendText(res, 200, challenge);
      return;
    }

    if (req.method !== 'POST' || !this.webhookTransport.handleWebhookRequest) {
      this.sendJson(res, 405, { error: 'method not allowed' });
      return;
    }

    try {
      const rawBody = await this.readBody(req, 10 * 1024 * 1024);
      const result = await this.webhookTransport.handleWebhookRequest(
        rawBody,
        req.headers
      );
      if (
        result.statusCode >= 200 &&
        result.statusCode < 300 &&
        this.verifiedWebhookForwarder
      ) {
        try {
          this.verifiedWebhookForwarder(rawBody);
        } catch (error) {
          logger.warn('Unable to enqueue verified provider webhook', {
            error: error instanceof Error ? error.message : 'unknown error',
          });
        }
      }
      if (typeof result.body === 'string') {
        this.sendText(res, result.statusCode, result.body);
      } else {
        this.sendJson(res, result.statusCode, result.body);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'webhook error';
      const status = message === 'payload too large' ? 413 : 400;
      logger.warn('Messaging webhook request rejected', { error: message });
      this.sendJson(res, status, { error: message });
    }
  }

  private readBody(
    req: http.IncomingMessage,
    maxBytes: number
  ): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      req.on('data', chunk => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += buffer.length;
        if (size > maxBytes) {
          reject(new Error('payload too large'));
          req.destroy();
          return;
        }
        chunks.push(buffer);
      });
      req.on('end', () => resolve(Buffer.concat(chunks)));
      req.on('error', reject);
    });
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
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-Content-Type-Options', 'nosniff');

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

  private sendText(
    res: http.ServerResponse,
    statusCode: number,
    body: string
  ): void {
    res.writeHead(statusCode, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(body);
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
