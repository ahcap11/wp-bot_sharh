import type {
  BotRole,
  SharhSyncOperationKind,
  WhatsAppMessage,
} from '../types';
import type { LeadCaptureRecord } from './lead-capture.service';
import { PersistenceService } from './persistence.service';
import type { SharhApiService } from './sharh-api.service';
import { logger } from '../utils/logger';

const OUTBOX_NAMESPACE = 'sharh_api_outbox';

interface OutboxOperation {
  id: string;
  kind: SharhSyncOperationKind;
  idempotencyKey: string;
  payload: Record<string, unknown>;
  attempts: number;
  createdAt: number;
  nextAttemptAt: number;
  lastError?: string | undefined;
}

/**
 * Local durable outbox for SHARH API writes. When the backend is temporarily
 * unavailable, lead/message/analytics events remain in the existing state file
 * and are retried without blocking the client conversation.
 */
export class SharhSyncService {
  private readonly operations: Map<string, OutboxOperation> = new Map();
  private interval: NodeJS.Timeout | null = null;
  private flushing: Promise<void> | null = null;

  constructor(
    private readonly api: SharhApiService,
    private readonly persistence: PersistenceService | null
  ) {
    this.hydrate();
  }

  start(): void {
    if (!this.api.isEnabled() || this.interval) {
      return;
    }

    const config = this.api.getConfig();
    this.interval = setInterval(() => {
      this.triggerFlush();
    }, config.syncIntervalMs);
    this.interval.unref();
    this.triggerFlush();
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  getPendingCount(): number {
    return this.operations.size;
  }

  enqueueMessage(
    chatId: string,
    direction: 'inbound' | 'outbound',
    message: WhatsAppMessage,
    role: BotRole
  ): void {
    if (!this.api.isEnabled()) {
      return;
    }

    const idempotencyKey = this.api.buildIdempotencyKey(
      'message',
      direction,
      message.id
    );
    this.enqueue('message', idempotencyKey, {
      chatId,
      direction,
      message,
      role,
    });
  }

  enqueueLead(record: LeadCaptureRecord, sourceMessageId: string): void {
    if (!this.api.isEnabled()) {
      return;
    }

    const idempotencyKey = this.api.buildIdempotencyKey(
      'lead',
      record.chatId,
      sourceMessageId,
      record.funnelStage,
      record.fieldsUpdated
    );
    this.enqueue('lead_snapshot', idempotencyKey, { record });
  }

  enqueueAccessRequest(
    record: LeadCaptureRecord,
    sourceMessageId: string
  ): void {
    if (!this.api.isEnabled() || !record.specificListingCode) {
      return;
    }

    const idempotencyKey = this.api.buildIdempotencyKey(
      'access-request',
      record.chatId,
      record.specificListingCode,
      sourceMessageId
    );
    this.enqueue('access_request', idempotencyKey, { record });
  }

  enqueueProviderWebhook(rawBody: Buffer | string): void {
    if (!this.api.isEnabled()) {
      return;
    }

    const payload = this.statusOnlyWebhook(rawBody);
    if (!payload) {
      return;
    }
    const serialized = JSON.stringify(payload);
    const idempotencyKey = this.api.buildIdempotencyKey(
      'provider-event',
      serialized
    );
    this.enqueue('provider_event', idempotencyKey, payload);
  }

  enqueueAnalytics(
    eventName: string,
    chatId: string,
    payload: Record<string, unknown>,
    sourceId: string
  ): void {
    if (!this.api.isEnabled()) {
      return;
    }

    const idempotencyKey = this.api.buildIdempotencyKey(
      'analytics',
      eventName,
      chatId,
      sourceId
    );
    this.enqueue('analytics', idempotencyKey, {
      eventName,
      chatId,
      payload,
    });
  }

  async flush(): Promise<void> {
    if (!this.api.isEnabled()) {
      return;
    }
    if (this.flushing) {
      return this.flushing;
    }

    this.flushing = this.flushInternal().finally(() => {
      this.flushing = null;
    });
    return this.flushing;
  }

  private hydrate(): void {
    if (!this.persistence) {
      return;
    }

    const stored = this.persistence.getNamespace<OutboxOperation>(
      OUTBOX_NAMESPACE
    );
    for (const [id, operation] of Object.entries(stored)) {
      if (operation && operation.id === id) {
        this.operations.set(id, operation);
      }
    }
  }

  private enqueue(
    kind: SharhSyncOperationKind,
    idempotencyKey: string,
    payload: Record<string, unknown>
  ): void {
    if (this.operations.has(idempotencyKey)) {
      return;
    }

    const operation: OutboxOperation = {
      id: idempotencyKey,
      kind,
      idempotencyKey,
      payload,
      attempts: 0,
      createdAt: Date.now(),
      nextAttemptAt: Date.now(),
    };
    this.operations.set(operation.id, operation);
    this.persistence?.setItem(OUTBOX_NAMESPACE, operation.id, operation);
    this.triggerFlush();
  }

  private triggerFlush(): void {
    void this.flush().catch(error => {
      logger.error('Unexpected SHARH outbox flush failure; process will continue', {
        error: error instanceof Error ? error.message : 'unknown error',
      });
    });
  }

  private async flushInternal(): Promise<void> {
    const now = Date.now();
    const config = this.api.getConfig();
    const due = Array.from(this.operations.values())
      .filter(operation => operation.nextAttemptAt <= now)
      .sort((a, b) => a.createdAt - b.createdAt)
      .slice(0, config.syncBatchSize);

    for (const operation of due) {
      let succeeded = false;
      let failureReason = 'SHARH API request failed';

      try {
        succeeded = await this.dispatch(operation);
      } catch (error) {
        failureReason =
          error instanceof Error ? error.message : 'unexpected dispatch error';
        logger.error('SHARH sync operation threw; keeping bot process alive', {
          operationId: operation.id,
          kind: operation.kind,
          error: failureReason,
        });
      }

      if (succeeded) {
        this.operations.delete(operation.id);
        this.persistence?.removeItem(OUTBOX_NAMESPACE, operation.id);
        continue;
      }

      operation.attempts += 1;
      operation.lastError = failureReason;
      if (operation.attempts >= config.syncMaxAttempts) {
        operation.nextAttemptAt = Date.now() + 60 * 60 * 1000;
        logger.error('SHARH sync operation reached retry limit', {
          operationId: operation.id,
          kind: operation.kind,
          attempts: operation.attempts,
          error: operation.lastError,
        });
      } else {
        operation.nextAttemptAt = Date.now() + this.backoffMs(operation.attempts);
      }
      this.persistence?.setItem(OUTBOX_NAMESPACE, operation.id, operation);
    }
  }

  private async dispatch(operation: OutboxOperation): Promise<boolean> {
    switch (operation.kind) {
      case 'message': {
        const chatId = this.readString(operation.payload, 'chatId');
        const direction = operation.payload['direction'];
        const role = this.readString(operation.payload, 'role');
        const message = operation.payload['message'];
        if (
          !chatId ||
          (direction !== 'inbound' && direction !== 'outbound') ||
          !this.isWhatsAppMessage(message)
        ) {
          return true;
        }
        return this.api.ingestMessage(
          chatId,
          direction,
          message,
          role,
          operation.idempotencyKey
        );
      }
      case 'lead_snapshot': {
        const record = operation.payload['record'];
        if (!this.isLeadRecord(record)) {
          return true;
        }
        return this.api.syncLeadSnapshot(record, operation.idempotencyKey);
      }
      case 'access_request': {
        const record = operation.payload['record'];
        if (!this.isLeadRecord(record) || !record.specificListingCode) {
          return true;
        }
        return this.api.createAccessRequest(record, operation.idempotencyKey);
      }
      case 'provider_event': {
        return this.api.forwardWhatsAppProviderEvent(
          operation.payload,
          operation.idempotencyKey
        );
      }
      case 'analytics': {
        const eventName = this.readString(operation.payload, 'eventName');
        const chatId = this.readString(operation.payload, 'chatId');
        const payload = operation.payload['payload'];
        if (!eventName || !chatId || !this.isRecord(payload)) {
          return true;
        }
        return this.api.recordAnalytics(
          eventName,
          chatId,
          payload,
          operation.idempotencyKey
        );
      }
      default:
        return true;
    }
  }

  private statusOnlyWebhook(
    rawBody: Buffer | string
  ): Record<string, unknown> | null {
    let raw: unknown;
    try {
      raw = JSON.parse(
        Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : rawBody
      ) as unknown;
    } catch {
      return null;
    }
    if (!this.isRecord(raw) || raw['object'] !== 'whatsapp_business_account') {
      return null;
    }

    const entries = Array.isArray(raw['entry']) ? raw['entry'] : [];
    const sanitizedEntries: Record<string, unknown>[] = [];
    for (const entry of entries) {
      if (!this.isRecord(entry)) continue;
      const changes = Array.isArray(entry['changes']) ? entry['changes'] : [];
      const sanitizedChanges: Record<string, unknown>[] = [];
      for (const change of changes) {
        if (!this.isRecord(change) || change['field'] !== 'messages') continue;
        const value = change['value'];
        if (!this.isRecord(value) || !Array.isArray(value['statuses'])) continue;
        const statuses = value['statuses'].filter(item => this.isRecord(item));
        if (!statuses.length) continue;
        sanitizedChanges.push({
          field: 'messages',
          value: {
            ...(this.isRecord(value['metadata'])
              ? { metadata: value['metadata'] }
              : {}),
            statuses,
          },
        });
      }
      if (sanitizedChanges.length) {
        sanitizedEntries.push({
          ...(typeof entry['id'] === 'string' ? { id: entry['id'] } : {}),
          changes: sanitizedChanges,
        });
      }
    }
    if (!sanitizedEntries.length) return null;
    return { object: 'whatsapp_business_account', entry: sanitizedEntries };
  }

  private backoffMs(attempts: number): number {
    return Math.min(5 * 60 * 1000, 1000 * 2 ** Math.min(attempts, 8));
  }

  private readString(payload: Record<string, unknown>, key: string): string {
    const value = payload[key];
    return typeof value === 'string' ? value : '';
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  }

  private isWhatsAppMessage(value: unknown): value is WhatsAppMessage {
    if (!this.isRecord(value)) {
      return false;
    }
    return (
      typeof value['id'] === 'string' &&
      typeof value['from'] === 'string' &&
      typeof value['to'] === 'string' &&
      typeof value['timestamp'] === 'number' &&
      typeof value['content'] === 'string' &&
      typeof value['isGroup'] === 'boolean'
    );
  }

  private isLeadRecord(value: unknown): value is LeadCaptureRecord {
    if (!this.isRecord(value)) {
      return false;
    }
    return (
      typeof value['chatId'] === 'string' &&
      typeof value['timestamp'] === 'string' &&
      typeof value['funnelStage'] === 'string' &&
      typeof value['status'] === 'string'
    );
  }
}
