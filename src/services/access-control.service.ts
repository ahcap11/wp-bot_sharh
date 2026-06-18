import { AccessControlConfig } from '../types';
import { logger } from '../utils/logger';

/**
 * Gatekeeps inbound messages with an optional sender allowlist and a
 * per-sender sliding-window rate limit. Both controls are independent and
 * can be enabled/disabled separately.
 */
export class AccessControlService {
  private readonly config: AccessControlConfig;
  private readonly allowed: Set<string>;
  private readonly hits: Map<string, number[]> = new Map();

  constructor(config: AccessControlConfig) {
    this.config = config;
    this.allowed = new Set(
      config.allowedNumbers.map(value => this.normalize(value)).filter(Boolean)
    );

    if (config.allowlistEnabled) {
      logger.info('Access control allowlist enabled', {
        entries: this.allowed.size,
      });
    }
    if (config.rateLimitEnabled) {
      logger.info('Access control rate limit enabled', {
        maxMessages: config.rateLimitMaxMessages,
        windowMs: config.rateLimitWindowMs,
      });
    }
  }

  /**
   * True when the sender is permitted (allowlist disabled = everyone allowed).
   */
  isSenderAllowed(senderJid: string): boolean {
    if (!this.config.allowlistEnabled) {
      return true;
    }
    return this.allowed.has(this.normalize(senderJid));
  }

  /**
   * Record a message for the sender and report whether it is within the limit.
   * When rate limiting is disabled, always returns true and records nothing.
   */
  isWithinRateLimit(senderJid: string, now: number = Date.now()): boolean {
    if (!this.config.rateLimitEnabled) {
      return true;
    }

    const key = this.normalize(senderJid) || senderJid;
    const windowStart = now - this.config.rateLimitWindowMs;
    const recent = (this.hits.get(key) || []).filter(
      timestamp => timestamp > windowStart
    );

    if (recent.length >= this.config.rateLimitMaxMessages) {
      this.hits.set(key, recent);
      return false;
    }

    recent.push(now);
    this.hits.set(key, recent);
    return true;
  }

  /**
   * Combined gate used by the message pipeline.
   */
  evaluate(senderJid: string): { allowed: boolean; reason?: string } {
    if (!this.isSenderAllowed(senderJid)) {
      return { allowed: false, reason: 'not_in_allowlist' };
    }
    if (!this.isWithinRateLimit(senderJid)) {
      return { allowed: false, reason: 'rate_limited' };
    }
    return { allowed: true };
  }

  private normalize(value: string): string {
    const localPart = value.split('@')[0] || '';
    return localPart.replace(/\D/g, '');
  }
}
