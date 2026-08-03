import http from 'http';
import { HealthService, HealthSnapshot } from '../services/health.service';

const readySnapshot: HealthSnapshot = {
  whatsappConnected: true,
  aiServiceConnected: true,
  webSocketClients: 2,
  totalChats: 5,
  totalMessages: 42,
};

const notReadySnapshot: HealthSnapshot = {
  whatsappConnected: false,
  aiServiceConnected: true,
  webSocketClients: 0,
  totalChats: 0,
  totalMessages: 0,
};

interface HttpResult {
  status: number;
  body: Record<string, unknown>;
}

const httpGet = (port: number, path: string): Promise<HttpResult> =>
  new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path }, res => {
      let data = '';
      res.on('data', chunk => {
        data += chunk;
      });
      res.on('end', () => {
        resolve({
          status: res.statusCode || 0,
          body: data ? JSON.parse(data) : {},
        });
      });
    });
    req.on('error', reject);
  });

describe('HealthService', () => {
  describe('buildStatus', () => {
    it('reports healthy when dependencies are connected', () => {
      const service = new HealthService(0, () => readySnapshot);
      const status = service.buildStatus();

      expect(status.status).toBe('healthy');
      expect(status.connections).toBe(2);
      expect(status.memory.rss).toBeGreaterThan(0);
      expect(service.isReady()).toBe(true);
    });

    it('reports unhealthy when a dependency is down', () => {
      const service = new HealthService(0, () => notReadySnapshot);

      expect(service.buildStatus().status).toBe('unhealthy');
      expect(service.isReady()).toBe(false);
    });

    it('treats a missing snapshot as not ready', () => {
      const service = new HealthService(0, () => null);
      expect(service.isReady()).toBe(false);
    });

    it('treats a throwing provider as not ready', () => {
      const service = new HealthService(0, () => {
        throw new Error('boom');
      });
      expect(service.isReady()).toBe(false);
    });
  });

  describe('HTTP probes', () => {
    const port = 39187;
    let service: HealthService;
    let ready = true;

    beforeAll(() => {
      service = new HealthService(port, () =>
        ready ? readySnapshot : notReadySnapshot
      );
      service.start();
    });

    afterAll(() => {
      service.stop();
    });

    it('returns 200 on /health regardless of readiness', async () => {
      ready = false;
      const result = await httpGet(port, '/health');
      expect(result.status).toBe(200);
      expect(result.body['status']).toBe('alive');
    });

    it('returns 200 on /ready when dependencies are up', async () => {
      ready = true;
      const result = await httpGet(port, '/ready');
      expect(result.status).toBe(200);
      expect(result.body['status']).toBe('healthy');
      expect(result.body['dependencies']).toEqual({ whatsapp: true, ai: true });
    });

    it('returns 503 on /ready when dependencies are down', async () => {
      ready = false;
      const result = await httpGet(port, '/ready');
      expect(result.status).toBe(503);
      expect(result.body['status']).toBe('unhealthy');
    });

    it('returns 404 for unknown paths', async () => {
      const result = await httpGet(port, '/nope');
      expect(result.status).toBe(404);
    });
  });
});
