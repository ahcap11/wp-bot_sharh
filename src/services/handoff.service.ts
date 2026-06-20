import { HandoffConfig, MessagingTransport } from '../types';
import { PersistenceService } from './persistence.service';
import { LeadCaptureRecord } from './lead-capture.service';
import { logger } from '../utils/logger';

const HANDOFF_NAMESPACE = 'handoff_notified';

/**
 * Notifies human managers when a lead is qualified or escalated.
 *
 * Sends a concise summary over the SAME messaging transport the bot already
 * uses (no extra channel), to the WhatsApp ids configured via
 * HANDOFF_WHATSAPP_JIDS. Notifications are idempotent per chat: once a chat has
 * been handed off, it is not notified again (survives restarts when persistence
 * is configured). When no ids are configured, it logs and no-ops so the bot
 * keeps working without a handoff target.
 */
export class HandoffService {
  private readonly transport: MessagingTransport;
  private readonly config: HandoffConfig;
  private readonly persistence: PersistenceService | null;
  private readonly notified: Set<string> = new Set();

  constructor(
    transport: MessagingTransport,
    config: HandoffConfig,
    persistence: PersistenceService | null = null
  ) {
    this.transport = transport;
    this.config = config;
    this.persistence = persistence;
    this.hydrate();
  }

  private hydrate(): void {
    if (!this.persistence) {
      return;
    }
    try {
      const stored = this.persistence.getNamespace(HANDOFF_NAMESPACE);
      Object.keys(stored || {}).forEach(chatId => this.notified.add(chatId));
    } catch (error) {
      logger.warn('Handoff notifier could not hydrate notified set', {
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  /**
   * Notify managers about a handoff-worthy lead. Safe to call on every update;
   * it only fires once per chat and only for terminal statuses.
   */
  async notify(chatId: string, record: LeadCaptureRecord): Promise<void> {
    if (
      record.status !== 'qualified_lead' &&
      record.status !== 'early_escalation'
    ) {
      return;
    }

    if (this.notified.has(chatId)) {
      return;
    }

    // Mark first so concurrent updates cannot double-send.
    this.notified.add(chatId);
    this.persistence?.setItem(HANDOFF_NAMESPACE, chatId, true);

    if (this.config.jids.length === 0) {
      logger.warn(
        'Lead ready for handoff but no HANDOFF_WHATSAPP_JIDS configured; ' +
          'notification skipped',
        { chatId, status: record.status }
      );
      return;
    }

    const summary = this.formatSummary(record);

    for (const jid of this.config.jids) {
      try {
        await this.transport.sendMessage(jid, summary);
      } catch (error) {
        logger.error('Failed to send handoff notification', {
          jid,
          chatId,
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    }

    logger.info('Handoff notification sent', {
      chatId,
      status: record.status,
      recipients: this.config.jids.length,
    });
  }

  private formatSummary(record: LeadCaptureRecord): string {
    const label =
      record.status === 'qualified_lead'
        ? 'QUALIFIED LEAD'
        : 'LEAD ESCALATION';

    const lines: string[] = [`Sharh — ${label}`];

    if (record.escalationReason) lines.push(`Reason: ${record.escalationReason}`);
    if (record.clientName) lines.push(`Name: ${record.clientName}`);
    if (record.clientPhone) lines.push(`Phone: ${record.clientPhone}`);
    if (record.inquiryPurpose) lines.push(`Purpose: ${record.inquiryPurpose}`);
    if (record.businessType) lines.push(`Business: ${record.businessType}`);
    if (record.annualRevenueAed)
      lines.push(`Annual revenue: ${record.annualRevenueAed}`);
    if (record.desiredSellingPriceAed)
      lines.push(`Asking price: ${record.desiredSellingPriceAed}`);
    if (record.notes) lines.push(`Notes: ${record.notes}`);

    return lines.join('\n');
  }
}
