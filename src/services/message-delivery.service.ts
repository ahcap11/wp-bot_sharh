import { createHash } from 'crypto';
import {
  MessageDeliveryStatus,
  MessageDeliveryUpdate,
  MessagingSendResult,
} from '../types';
import { logger } from '../utils/logger';
import { PersistenceService } from './persistence.service';

const NAMESPACE = 'messageDelivery';
const MAX_RECORDS = 5000;

export type OutboundMessagePurpose =
  | 'bot_reply'
  | 'system_notice';

export interface DeliveryRecord {
  localMessageId: string;
  providerMessageId: string;
  chatId: string;
  purpose: OutboundMessagePurpose;
  status: MessageDeliveryStatus;
  createdAt: string;
  updatedAt: string;
  contentHash: string;
  recipientId?: string | undefined;
  conversationId?: string | undefined;
  errorCode?: string | undefined;
  errorMessage?: string | undefined;
}

/** Persists provider ids and applies asynchronous delivery/read/failure updates. */
export class MessageDeliveryService {
  private readonly byProviderId = new Map<string, DeliveryRecord>();

  constructor(private readonly persistence: PersistenceService | null) {
    this.hydrate();
  }

  recordAccepted(
    localMessageId: string,
    chatId: string,
    content: string,
    purpose: OutboundMessagePurpose,
    result: MessagingSendResult
  ): void {
    if (!result.success) return;
    const now = new Date().toISOString();
    for (const providerMessageId of result.providerMessageIds) {
      if (!providerMessageId) continue;
      const record: DeliveryRecord = {
        localMessageId,
        providerMessageId,
        chatId,
        purpose,
        status: 'accepted',
        createdAt: now,
        updatedAt: now,
        contentHash: createHash('sha256').update(content).digest('hex'),
      };
      this.byProviderId.set(providerMessageId, record);
      this.persistence?.setItem(NAMESPACE, providerMessageId, record);
    }
    this.trim();
  }

  applyUpdate(update: MessageDeliveryUpdate): DeliveryRecord | null {
    const record = this.byProviderId.get(update.providerMessageId);
    if (!record) {
      logger.debug('Delivery update has no local outbound record', {
        providerMessageId: update.providerMessageId,
        status: update.status,
      });
      return null;
    }

    record.status = update.status;
    record.updatedAt = new Date(update.timestamp).toISOString();
    record.recipientId = update.recipientId;
    record.conversationId = update.conversationId;
    record.errorCode = update.errorCode;
    record.errorMessage = update.errorMessage;
    this.persistence?.setItem(NAMESPACE, record.providerMessageId, record);
    return { ...record };
  }

  get(providerMessageId: string): DeliveryRecord | null {
    const record = this.byProviderId.get(providerMessageId);
    return record ? { ...record } : null;
  }

  countByStatus(): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const record of this.byProviderId.values()) {
      counts[record.status] = (counts[record.status] || 0) + 1;
    }
    return counts;
  }

  private hydrate(): void {
    if (!this.persistence) return;
    const stored = this.persistence.getNamespace<DeliveryRecord>(NAMESPACE);
    for (const [providerMessageId, record] of Object.entries(stored)) {
      if (record?.providerMessageId === providerMessageId) {
        this.byProviderId.set(providerMessageId, record);
      }
    }
    this.trim();
  }

  private trim(): void {
    if (this.byProviderId.size <= MAX_RECORDS) return;
    const ordered = [...this.byProviderId.values()].sort((a, b) =>
      a.updatedAt.localeCompare(b.updatedAt)
    );
    const removeCount = this.byProviderId.size - MAX_RECORDS;
    for (const record of ordered.slice(0, removeCount)) {
      this.byProviderId.delete(record.providerMessageId);
      this.persistence?.removeItem(NAMESPACE, record.providerMessageId);
    }
  }
}
