import { HandoffConfig, MessagingTransport } from '../types';
import { PersistenceService } from './persistence.service';
import { LeadCaptureRecord } from './lead-capture.service';
import { logger } from '../utils/logger';

const HANDOFF_NAMESPACE = 'handoff_notified';

/**
 * Delivers manager handoffs over the configured messaging transport.
 *
 * A chat is marked delivered only after at least one manager notification is
 * actually sent. This prevents the previous failure mode where a lead was
 * permanently deduplicated before delivery succeeded.
 */
export class HandoffService {
  private readonly transport: MessagingTransport;
  private readonly config: HandoffConfig;
  private readonly persistence: PersistenceService | null;
  private readonly notified: Set<string> = new Set();
  private readonly inFlight: Map<string, Promise<boolean>> = new Map();

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
      const stored = this.persistence.getNamespace<boolean>(HANDOFF_NAMESPACE);
      Object.entries(stored || {}).forEach(([chatId, delivered]) => {
        if (delivered === true) this.notified.add(chatId);
      });
    } catch (error) {
      logger.warn('Handoff notifier could not hydrate delivered set', {
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  /**
   * Notify managers about a handoff-worthy lead.
   * Returns true when delivery has already succeeded or succeeds now.
   */
  async notify(chatId: string, record: LeadCaptureRecord): Promise<boolean> {
    if (
      record.status !== 'qualified_lead' &&
      record.status !== 'early_escalation' &&
      record.status !== 'handoff_pending'
    ) {
      return false;
    }

    if (this.notified.has(chatId)) {
      return true;
    }

    const existing = this.inFlight.get(chatId);
    if (existing) {
      return existing;
    }

    const delivery = this.deliver(chatId, record).finally(() => {
      this.inFlight.delete(chatId);
    });
    this.inFlight.set(chatId, delivery);
    return delivery;
  }

  private async deliver(
    chatId: string,
    record: LeadCaptureRecord
  ): Promise<boolean> {
    if (this.config.jids.length === 0) {
      logger.warn(
        'Lead ready for handoff but no HANDOFF_WHATSAPP_JIDS configured',
        { chatId, status: record.status }
      );
      return false;
    }

    const summary = this.formatSummary(record);
    let successfulDeliveries = 0;

    for (const jid of this.config.jids) {
      try {
        const sent = await this.transport.sendMessage(jid, summary);
        if (sent) {
          successfulDeliveries += 1;
        } else {
          logger.error('Handoff transport returned false', { jid, chatId });
        }
      } catch (error) {
        logger.error('Failed to send handoff notification', {
          jid,
          chatId,
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    }

    if (successfulDeliveries === 0) {
      logger.error('Handoff notification failed for all recipients', {
        chatId,
        recipients: this.config.jids.length,
      });
      return false;
    }

    this.notified.add(chatId);
    this.persistence?.setItem(HANDOFF_NAMESPACE, chatId, true);
    logger.info('Handoff notification delivered', {
      chatId,
      status: record.status,
      successfulDeliveries,
      configuredRecipients: this.config.jids.length,
    });
    return true;
  }

  private formatSummary(record: LeadCaptureRecord): string {
    const label =
      record.escalationReason === 'qualified_lead'
        ? 'QUALIFIED LEAD'
        : 'LEAD ESCALATION';

    const lines: string[] = [
      `SHARH — ${label}`,
      `Chat: ${record.chatId}`,
      `Stage: ${record.funnelStage}`,
      `Completion: ${record.completionPercent}%`,
    ];

    if (record.notes) lines.push(`Reason: ${record.notes}`);
    if (record.clientName) lines.push(`Name: ${record.clientName}`);
    if (record.clientPhone) lines.push(`Phone: ${record.clientPhone}`);
    if (record.language) lines.push(`Language: ${record.language}`);
    if (record.inquiryPurpose) lines.push(`Purpose: ${record.inquiryPurpose}`);
    if (record.specificListingCode)
      lines.push(`Listing: ${record.specificListingCode}`);
    if (record.businessType) lines.push(`Business / sector: ${record.businessType}`);
    if (record.businessLocation)
      lines.push(`Business location: ${record.businessLocation}`);
    if (record.annualRevenueAed)
      lines.push(`Annual revenue: ${record.annualRevenueAed}`);
    if (record.leaseDetails) lines.push(`Lease: ${record.leaseDetails}`);
    if (record.desiredSellingPriceAed)
      lines.push(`Asking price: ${record.desiredSellingPriceAed}`);
    if (record.yearEstablished)
      lines.push(`Established: ${record.yearEstablished}`);
    if (record.employeeCount) lines.push(`Employees: ${record.employeeCount}`);
    if (record.monthlyOperatingExpensesAed)
      lines.push(`Monthly opex: ${record.monthlyOperatingExpensesAed}`);
    if (record.monthlyNetProfitAed)
      lines.push(`Monthly net profit: ${record.monthlyNetProfitAed}`);
    if (record.liabilities) lines.push(`Liabilities: ${record.liabilities}`);
    if (record.contractsLicenses)
      lines.push(`Contracts / licences: ${record.contractsLicenses}`);
    if (record.saleReasonUrgency)
      lines.push(`Reason / urgency: ${record.saleReasonUrgency}`);
    if (record.includedAssets)
      lines.push(`Included assets: ${record.includedAssets}`);
    if (record.buyerBudgetAed)
      lines.push(`Buyer budget: ${record.buyerBudgetAed}`);
    if (record.buyerLocation)
      lines.push(`Buyer location: ${record.buyerLocation}`);
    if (record.buyerTimeline)
      lines.push(`Buyer timeline: ${record.buyerTimeline}`);
    if (record.buyerInvolvement)
      lines.push(`Buyer involvement: ${record.buyerInvolvement}`);
    if (record.buyerFundingStatus)
      lines.push(`Funding: ${record.buyerFundingStatus}`);
    if (record.buyerAdditionalComments)
      lines.push(`Buyer comments: ${record.buyerAdditionalComments}`);

    return lines.join('\n');
  }
}
