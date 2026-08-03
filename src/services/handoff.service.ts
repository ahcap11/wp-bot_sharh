import { createHash, randomBytes } from 'crypto';
import {
  HandoffConfig,
  MessageDeliveryUpdate,
  MessagingSendResult,
  MessagingTransport,
} from '../types';
import { logger } from '../utils/logger';
import { LeadCaptureRecord } from './lead-capture.service';
import { MessageDeliveryService } from './message-delivery.service';
import { PersistenceService } from './persistence.service';
import { SharhApiService } from './sharh-api.service';
import { SharhSyncService } from './sharh-sync.service';

const HANDOFF_NAMESPACE = 'handoffRecordsV2';

export type HandoffStatus =
  | 'pending'
  | 'notified'
  | 'accepted'
  | 'released'
  | 'closed'
  | 'failed';

export interface HandoffRecord {
  id: string;
  chatId: string;
  status: HandoffStatus;
  reason: string;
  leadSnapshot: LeadCaptureRecord;
  assignedManagerJid?: string | undefined;
  providerMessageIds: string[];
  attempts: number;
  createdAt: string;
  updatedAt: string;
  nextAttemptAt?: string | undefined;
  notifiedAt?: string | undefined;
  acceptedAt?: string | undefined;
  releasedAt?: string | undefined;
  closedAt?: string | undefined;
  lastError?: string | undefined;
}

export interface HandoffNotificationResult {
  handoff: HandoffRecord;
  notified: boolean;
  accepted: boolean;
}

export interface OperatorCommandResult {
  handled: boolean;
  reply?: string | undefined;
  targetChatId?: string | undefined;
  transition?: 'accepted' | 'released' | 'closed' | undefined;
  customerMessage?: string | undefined;
}

/** Durable manager assignment, notification retry, and takeover commands. */
export class HandoffService {
  private readonly records = new Map<string, HandoffRecord>();
  private readonly activeByChat = new Map<string, string>();
  private readonly inFlight = new Map<string, Promise<HandoffNotificationResult>>();
  private retryTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly transport: MessagingTransport,
    private readonly config: HandoffConfig,
    private readonly persistence: PersistenceService | null = null,
    private readonly sharhApi: SharhApiService | null = null,
    private readonly deliveries: MessageDeliveryService | null = null,
    private readonly sharhSync: SharhSyncService | null = null
  ) {
    this.hydrate();
  }

  start(): void {
    if (this.retryTimer) return;
    this.retryTimer = setInterval(() => {
      void this.retryPending();
    }, this.config.retryIntervalMs);
    this.retryTimer.unref();
    void this.retryPending();
  }

  stop(): void {
    if (this.retryTimer) {
      clearInterval(this.retryTimer);
      this.retryTimer = null;
    }
  }

  async notify(
    chatId: string,
    leadSnapshot: LeadCaptureRecord
  ): Promise<HandoffNotificationResult> {
    let record = this.getActiveForChat(chatId);
    if (!record || record.status === 'closed' || record.status === 'released') {
      record = this.createRecord(chatId, leadSnapshot);
    } else {
      record.leadSnapshot = leadSnapshot;
      record.reason = leadSnapshot.escalationReason || leadSnapshot.status;
      record.updatedAt = new Date().toISOString();
      this.persist(record);
    }

    if (record.status === 'accepted') {
      return { handoff: { ...record }, notified: true, accepted: true };
    }
    if (record.status === 'notified') {
      return { handoff: { ...record }, notified: true, accepted: false };
    }

    const existing = this.inFlight.get(record.id);
    if (existing) return existing;

    const attempt = this.attemptDelivery(record).finally(() => {
      this.inFlight.delete(record!.id);
    });
    this.inFlight.set(record.id, attempt);
    return attempt;
  }

  handleDeliveryUpdate(update: MessageDeliveryUpdate): void {
    const record = [...this.records.values()].find(item =>
      item.providerMessageIds.includes(update.providerMessageId)
    );
    if (!record) return;

    if (update.status === 'failed' && record.status === 'notified') {
      record.status =
        record.attempts >= this.config.maxAttempts ? 'failed' : 'pending';
      record.lastError = update.errorMessage || update.errorCode || 'provider delivery failed';
      record.nextAttemptAt = this.nextAttempt(record.attempts);
      record.updatedAt = new Date().toISOString();
      this.persist(record);
      logger.warn('Handoff notification returned failed delivery status', {
        handoffId: record.id,
        providerMessageId: update.providerMessageId,
      });
      return;
    }

    if (update.status === 'delivered' || update.status === 'read') {
      record.updatedAt = new Date(update.timestamp).toISOString();
      this.persist(record);
    }
  }

  async executeOperatorCommand(
    operatorJid: string,
    content: string
  ): Promise<OperatorCommandResult> {
    const normalized = content.trim();
    if (!normalized.startsWith('/')) return { handled: false };

    if (/^\/handoffs\b/i.test(normalized)) {
      const active = [...this.records.values()]
        .filter(record => ['pending', 'failed', 'notified', 'accepted'].includes(record.status))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .slice(0, 10);
      return {
        handled: true,
        reply:
          active.length === 0
            ? 'No active handoffs.'
            : active
                .map(
                  item =>
                    `${item.id} — ${item.status} — ${item.leadSnapshot.clientName || item.leadSnapshot.clientPhone || item.chatId}`
                )
                .join('\n'),
      };
    }

    const replyMatch = normalized.match(/^\/reply\s+(HF-[A-Z0-9]+)\s+([\s\S]+)$/i);
    if (replyMatch) {
      const record = this.find(replyMatch[1] as string);
      if (!record) return { handled: true, reply: 'Handoff not found.' };
      if (record.status !== 'accepted') {
        return { handled: true, reply: 'Accept the handoff before replying.' };
      }
      const message = (replyMatch[2] as string).trim();
      const result = await this.sendDetailed(record.chatId, message);
      if (result.success) {
        const localId = `manager-${record.id}-${Date.now()}`;
        this.deliveries?.recordAccepted(
          localId,
          record.chatId,
          message,
          'manager_reply',
          result
        );
        if (this.sharhApi?.isEnabled()) {
          const providerMessageId = result.providerMessageIds[0] || localId;
          await this.sharhApi.ingestMessage(
            record.chatId,
            'outbound',
            {
              id: providerMessageId,
              from: operatorJid,
              to: record.chatId,
              timestamp: Date.now(),
              type: 'text',
              content: message,
              isGroup: false,
              senderName: 'SHARH Manager',
              isFromBot: false,
            },
            'human_manager',
            this.sharhApi.buildIdempotencyKey(
              'manager-reply',
              record.id,
              providerMessageId
            )
          );
        }
        return { handled: true, reply: `Reply sent for ${record.id}.` };
      }
      return {
        handled: true,
        reply: `Reply failed for ${record.id}: ${result.error || 'transport error'}`,
      };
    }

    const command = normalized.match(
      /^\/(accept|pause|resume|release|close|status)\s+(HF-[A-Z0-9]+)\s*$/i
    );
    if (!command) return { handled: false };

    const action = (command[1] as string).toLowerCase();
    const record = this.find(command[2] as string);
    if (!record) return { handled: true, reply: 'Handoff not found.' };

    if (action === 'status') {
      return {
        handled: true,
        reply: this.formatOperatorStatus(record),
      };
    }

    const now = new Date().toISOString();
    if (action === 'accept' || action === 'pause') {
      if (record.status === 'closed') {
        return { handled: true, reply: `${record.id} is already closed.` };
      }
      record.status = 'accepted';
      record.assignedManagerJid = operatorJid;
      record.acceptedAt = now;
      record.updatedAt = now;
      record.nextAttemptAt = undefined;
      this.persist(record);
      await this.recordCanonicalEvent(record, 'accepted', operatorJid);
      return {
        handled: true,
        reply: `${record.id} accepted. The bot is paused for the client. Use /reply ${record.id} <message>, /resume ${record.id}, or /close ${record.id}.`,
        targetChatId: record.chatId,
        transition: 'accepted',
        customerMessage: 'A SHARH manager has joined the conversation and will continue with you directly.',
      };
    }

    if (action === 'resume' || action === 'release') {
      record.status = 'released';
      record.assignedManagerJid = operatorJid;
      record.releasedAt = now;
      record.updatedAt = now;
      record.nextAttemptAt = undefined;
      this.persist(record);
      this.activeByChat.delete(record.chatId);
      await this.recordCanonicalEvent(record, 'released', operatorJid);
      return {
        handled: true,
        reply: `${record.id} released. The bot resumes in support mode.`,
        targetChatId: record.chatId,
        transition: 'released',
        customerMessage: 'The automated SHARH assistant is available again. How can I help with the next step?',
      };
    }

    record.status = 'closed';
    record.assignedManagerJid = operatorJid;
    record.closedAt = now;
    record.updatedAt = now;
    record.nextAttemptAt = undefined;
    this.persist(record);
    this.activeByChat.delete(record.chatId);
    await this.recordCanonicalEvent(record, 'closed', operatorJid);
    return {
      handled: true,
      reply: `${record.id} closed.`,
      targetChatId: record.chatId,
      transition: 'closed',
    };
  }

  getActiveCount(): number {
    return [...this.records.values()].filter(record =>
      ['pending', 'failed', 'notified', 'accepted'].includes(record.status)
    ).length;
  }

  private async retryPending(): Promise<void> {
    const now = Date.now();
    const candidates = [...this.records.values()].filter(record => {
      if (!['pending', 'failed'].includes(record.status)) return false;
      if (record.attempts >= this.config.maxAttempts) return false;
      return !record.nextAttemptAt || Date.parse(record.nextAttemptAt) <= now;
    });
    for (const record of candidates) {
      if (this.inFlight.has(record.id)) continue;
      const attempt = this.attemptDelivery(record).finally(() => {
        this.inFlight.delete(record.id);
      });
      this.inFlight.set(record.id, attempt);
      await attempt;
    }
  }

  private async attemptDelivery(
    record: HandoffRecord
  ): Promise<HandoffNotificationResult> {
    record.attempts += 1;
    record.updatedAt = new Date().toISOString();
    record.status = 'pending';
    this.persist(record);

    if (this.sharhApi?.isEnabled()) {
      const leadKey = this.sharhApi.buildIdempotencyKey(
        'lead-before-handoff',
        record.chatId,
        record.leadSnapshot.funnelStage,
        record.reason
      );
      const leadPersisted = await this.sharhApi.syncLeadSnapshot(
        record.leadSnapshot,
        leadKey
      );
      if (!leadPersisted && this.sharhApi.requiresHandoffPersistence()) {
        return this.fail(record, 'canonical lead persistence failed');
      }

      const handoffKey = this.sharhApi.buildIdempotencyKey(
        'handoff',
        record.id,
        record.chatId,
        record.reason
      );
      const handoffPersisted = await this.sharhApi.createHandoff(
        record.leadSnapshot,
        handoffKey,
        {
          handoffReference: record.id,
          assignedManagerJid: this.config.jids[0] || null,
        }
      );
      if (!handoffPersisted && this.sharhApi.requiresHandoffPersistence()) {
        return this.fail(record, 'SHARH handoff persistence failed');
      }
    }

    if (this.config.jids.length === 0) {
      return this.fail(record, 'no HANDOFF_WHATSAPP_JIDS configured');
    }

    const summary = this.formatSummary(record);
    for (const jid of this.config.jids) {
      const result = await this.sendDetailed(jid, summary);
      if (!result.success) {
        record.lastError = result.error || 'transport returned failure';
        continue;
      }

      record.status = 'notified';
      record.assignedManagerJid = jid;
      record.providerMessageIds = result.providerMessageIds;
      record.notifiedAt = new Date().toISOString();
      record.updatedAt = record.notifiedAt;
      record.nextAttemptAt = undefined;
      record.lastError = undefined;
      this.persist(record);
      this.deliveries?.recordAccepted(
        `handoff-${record.id}-${record.attempts}`,
        jid,
        summary,
        'handoff_notification',
        result
      );
      logger.info('Handoff manager notification accepted by transport', {
        handoffId: record.id,
        chatId: record.chatId,
        managerJid: jid,
        attempts: record.attempts,
      });
      await this.recordCanonicalEvent(record, 'notified', jid);
      return { handoff: { ...record }, notified: true, accepted: false };
    }

    return this.fail(record, record.lastError || 'all manager notifications failed');
  }

  private fail(
    record: HandoffRecord,
    error: string
  ): HandoffNotificationResult {
    record.status = record.attempts >= this.config.maxAttempts ? 'failed' : 'pending';
    record.lastError = error;
    record.updatedAt = new Date().toISOString();
    record.nextAttemptAt = this.nextAttempt(record.attempts);
    this.persist(record);
    logger.error('Handoff notification attempt failed', {
      handoffId: record.id,
      chatId: record.chatId,
      attempts: record.attempts,
      error,
    });
    return { handoff: { ...record }, notified: false, accepted: false };
  }

  private createRecord(
    chatId: string,
    leadSnapshot: LeadCaptureRecord
  ): HandoffRecord {
    const now = new Date().toISOString();
    const record: HandoffRecord = {
      id: this.createReference(chatId),
      chatId,
      status: 'pending',
      reason: leadSnapshot.escalationReason || leadSnapshot.status,
      leadSnapshot,
      providerMessageIds: [],
      attempts: 0,
      createdAt: now,
      updatedAt: now,
    };
    this.records.set(record.id, record);
    this.activeByChat.set(chatId, record.id);
    this.persist(record);
    return record;
  }

  private getActiveForChat(chatId: string): HandoffRecord | null {
    const id = this.activeByChat.get(chatId);
    return id ? this.records.get(id) || null : null;
  }

  private find(id: string): HandoffRecord | null {
    return this.records.get(id.toUpperCase()) || null;
  }

  private async sendDetailed(
    chatId: string,
    message: string
  ): Promise<MessagingSendResult> {
    if (this.transport.sendMessageDetailed) {
      return this.transport.sendMessageDetailed(chatId, message);
    }
    const success = await this.transport.sendMessage(chatId, message);
    return { success, providerMessageIds: [] };
  }

  private async recordCanonicalEvent(
    record: HandoffRecord,
    event: 'notified' | 'accepted' | 'released' | 'closed',
    operatorJid: string
  ): Promise<void> {
    if (!this.sharhApi?.isEnabled()) return;
    if (this.sharhSync) {
      this.sharhSync.enqueueHandoffEvent(record.id, event, operatorJid);
      return;
    }

    const key = this.sharhApi.buildIdempotencyKey(
      'handoff-event',
      record.id,
      event,
      operatorJid
    );
    const ok = await this.sharhApi.recordHandoffEvent(
      record.id,
      event,
      operatorJid,
      key
    );
    if (!ok) {
      logger.warn('SHARH handoff transition could not be persisted immediately', {
        handoffId: record.id,
        event,
      });
    }
  }

  private formatSummary(record: HandoffRecord): string {
    const lead = record.leadSnapshot;
    const lines: string[] = [
      'SHARH — MANAGER HANDOFF',
      `Reference: ${record.id}`,
      `Stage: ${lead.funnelStage}`,
      `Completion: ${lead.completionPercent}%`,
      `Reason: ${lead.notes || record.reason}`,
    ];
    lines.push(`Score: ${lead.leadScore}/100 — ${lead.leadGrade} — ${lead.leadTemperature}`);
    lines.push(`Next action: ${lead.nextBestAction}`);
    if (lead.clientName) lines.push(`Name: ${lead.clientName}`);
    if (lead.clientPhone) lines.push(`Phone: ${lead.clientPhone}`);
    if (lead.language) lines.push(`Language: ${lead.language}`);
    if (lead.inquiryPurpose) lines.push(`Purpose: ${lead.inquiryPurpose}`);
    if (lead.specificListingCode) lines.push(`Listing: ${lead.specificListingCode}`);
    if (lead.businessType) lines.push(`Business / sector: ${lead.businessType}`);
    if (lead.businessLocation) lines.push(`Location: ${lead.businessLocation}`);
    if (lead.annualRevenueAed) lines.push(`Annual revenue: ${lead.annualRevenueAed}`);
    if (lead.monthlyNetProfitAed) lines.push(`Monthly net profit: ${lead.monthlyNetProfitAed}`);
    if (lead.desiredSellingPriceAed) lines.push(`Asking price: ${lead.desiredSellingPriceAed}`);
    if (lead.buyerBudgetAed) lines.push(`Buyer budget: ${lead.buyerBudgetAed}`);
    if (lead.buyerTimeline) lines.push(`Timeline: ${lead.buyerTimeline}`);
    if (lead.objectionsDetected) lines.push(`Objections: ${lead.objectionsDetected}`);
    if (lead.riskFlags) lines.push(`Risk flags: ${lead.riskFlags}`);
    if (lead.conversationSummary) {
      lines.push('');
      lines.push(`Summary: ${lead.conversationSummary}`);
    }
    lines.push('');
    lines.push(`Accept and pause bot: /accept ${record.id}`);
    lines.push(`Check status: /status ${record.id}`);
    return lines.join('\n');
  }

  private formatOperatorStatus(record: HandoffRecord): string {
    return [
      `${record.id} — ${record.status}`,
      `Client: ${record.leadSnapshot.clientName || 'unknown'} (${record.leadSnapshot.clientPhone || record.chatId})`,
      `Manager: ${record.assignedManagerJid || 'unassigned'}`,
      `Attempts: ${record.attempts}/${this.config.maxAttempts}`,
      `Lead score: ${record.leadSnapshot.leadScore}/100 (${record.leadSnapshot.leadGrade})`,
      `Next action: ${record.leadSnapshot.nextBestAction}`,
      record.lastError ? `Last error: ${record.lastError}` : '',
    ]
      .filter(Boolean)
      .join('\n');
  }

  private nextAttempt(attempts: number): string {
    const multiplier = Math.min(32, 2 ** Math.max(0, attempts - 1));
    return new Date(Date.now() + this.config.retryIntervalMs * multiplier).toISOString();
  }

  private createReference(chatId: string): string {
    const digest = createHash('sha256')
      .update(`${chatId}:${Date.now()}:${randomBytes(8).toString('hex')}`)
      .digest('hex')
      .slice(0, 10)
      .toUpperCase();
    return `HF-${digest}`;
  }

  private hydrate(): void {
    if (!this.persistence) return;
    const stored = this.persistence.getNamespace<HandoffRecord>(HANDOFF_NAMESPACE);
    for (const [id, record] of Object.entries(stored)) {
      if (!record || record.id !== id) continue;
      this.records.set(id, record);
      if (!['closed', 'released'].includes(record.status)) {
        this.activeByChat.set(record.chatId, id);
      }
    }
  }

  private persist(record: HandoffRecord): void {
    this.records.set(record.id, record);
    this.persistence?.setItem(HANDOFF_NAMESPACE, record.id, record);
  }
}
