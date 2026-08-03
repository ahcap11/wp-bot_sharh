import { AccessControlService } from '../services/access-control.service';
import { AccessControlConfig } from '../types';

const config = (
  overrides: Partial<AccessControlConfig> = {}
): AccessControlConfig => ({
  allowlistEnabled: false,
  allowedNumbers: [],
  rateLimitEnabled: false,
  rateLimitMaxMessages: 3,
  rateLimitWindowMs: 1000,
  ...overrides,
});

describe('AccessControlService', () => {
  describe('allowlist', () => {
    it('allows everyone when the allowlist is disabled', () => {
      const service = new AccessControlService(config());
      expect(service.isSenderAllowed('15551234567@s.whatsapp.net')).toBe(true);
    });

    it('allows only configured numbers when enabled', () => {
      const service = new AccessControlService(
        config({
          allowlistEnabled: true,
          allowedNumbers: ['+1 (555) 123-4567'],
        })
      );

      expect(service.isSenderAllowed('15551234567@s.whatsapp.net')).toBe(true);
      expect(service.isSenderAllowed('19999999999@s.whatsapp.net')).toBe(false);
    });
  });

  describe('rate limit', () => {
    it('does not limit when disabled', () => {
      const service = new AccessControlService(config());
      for (let i = 0; i < 10; i += 1) {
        expect(service.isWithinRateLimit('user@s.whatsapp.net')).toBe(true);
      }
    });

    it('blocks once the per-window threshold is exceeded', () => {
      const service = new AccessControlService(
        config({
          rateLimitEnabled: true,
          rateLimitMaxMessages: 3,
          rateLimitWindowMs: 1000,
        })
      );
      const sender = 'user@s.whatsapp.net';
      const now = 10_000;

      expect(service.isWithinRateLimit(sender, now)).toBe(true);
      expect(service.isWithinRateLimit(sender, now + 1)).toBe(true);
      expect(service.isWithinRateLimit(sender, now + 2)).toBe(true);
      expect(service.isWithinRateLimit(sender, now + 3)).toBe(false);
    });

    it('allows again after the window slides past old hits', () => {
      const service = new AccessControlService(
        config({
          rateLimitEnabled: true,
          rateLimitMaxMessages: 2,
          rateLimitWindowMs: 1000,
        })
      );
      const sender = 'user@s.whatsapp.net';

      expect(service.isWithinRateLimit(sender, 0)).toBe(true);
      expect(service.isWithinRateLimit(sender, 100)).toBe(true);
      expect(service.isWithinRateLimit(sender, 200)).toBe(false);
      // After the window passes, prior hits expire.
      expect(service.isWithinRateLimit(sender, 1500)).toBe(true);
    });

    it('tracks senders independently', () => {
      const service = new AccessControlService(
        config({
          rateLimitEnabled: true,
          rateLimitMaxMessages: 1,
          rateLimitWindowMs: 1000,
        })
      );

      expect(service.isWithinRateLimit('a@s.whatsapp.net', 0)).toBe(true);
      expect(service.isWithinRateLimit('a@s.whatsapp.net', 1)).toBe(false);
      expect(service.isWithinRateLimit('b@s.whatsapp.net', 1)).toBe(true);
    });
  });

  describe('evaluate', () => {
    it('reports allowlist rejection reason', () => {
      const service = new AccessControlService(
        config({ allowlistEnabled: true, allowedNumbers: ['15551234567'] })
      );

      expect(service.evaluate('19999999999@s.whatsapp.net')).toEqual({
        allowed: false,
        reason: 'not_in_allowlist',
      });
    });

    it('reports rate-limit rejection reason', () => {
      const service = new AccessControlService(
        config({
          rateLimitEnabled: true,
          rateLimitMaxMessages: 1,
          rateLimitWindowMs: 100000,
        })
      );
      const sender = 'user@s.whatsapp.net';

      expect(service.evaluate(sender).allowed).toBe(true);
      expect(service.evaluate(sender)).toEqual({
        allowed: false,
        reason: 'rate_limited',
      });
    });
  });
});
