import { createHmac, timingSafeEqual } from 'crypto';
import {
  ConnectionStatus,
  MessageDeliveryStatus,
  MessageDeliveryUpdate,
  MessagingConfig,
  MessagingSendResult,
  MessagingTransport,
  MessagingWebhookResult,
  WhatsAppMessage,
} from '../types';
import { logger } from '../utils/logger';

interface CloudApiMessageResponse {
  messages?: Array<{ id?: string }>;
  error?: { message?: string; code?: number; error_subcode?: number };
}

interface CloudWebhookPayload {
  object?: string;
  entry?: Array<{
    changes?: Array<{
      field?: string;
      value?: {
        metadata?: { phone_number_id?: string; display_phone_number?: string };
        contacts?: Array<{ wa_id?: string; profile?: { name?: string } }>;
        messages?: Array<Record<string, unknown>>;
        statuses?: Array<Record<string, unknown>>;
      };
    }>;
  }>;
}

/** Official WhatsApp Business Platform Cloud API transport. */
export class CloudApiTransport implements MessagingTransport {
  private readonly config: MessagingConfig;
  private connectionStatus: ConnectionStatus = ConnectionStatus.DISCONNECTED;
  private readonly messageHandlers: Array<(message: WhatsAppMessage) => void> = [];
  private readonly statusHandlers: Array<(status: ConnectionStatus) => void> = [];
  private readonly deliveryHandlers: Array<(update: MessageDeliveryUpdate) => void> = [];

  constructor(config: MessagingConfig) {
    this.config = config;
  }

  async initialize(): Promise<void> {
    const missing: string[] = [];
    if (!this.config.cloudPhoneNumberId) missing.push('WHATSAPP_CLOUD_PHONE_NUMBER_ID');
    if (!this.config.cloudAccessToken) missing.push('WHATSAPP_CLOUD_ACCESS_TOKEN');
    if (!this.config.cloudVerifyToken) missing.push('WHATSAPP_CLOUD_VERIFY_TOKEN');
    if (!this.config.cloudAppSecret) missing.push('WHATSAPP_CLOUD_APP_SECRET');
    if (missing.length > 0) {
      throw new Error(`CloudApiTransport missing required settings: ${missing.join(', ')}`);
    }

    this.setStatus(ConnectionStatus.READY);
    logger.info('WhatsApp Cloud API transport initialized', {
      phoneNumberId: this.mask(this.config.cloudPhoneNumberId),
      apiVersion: this.config.cloudApiVersion,
      webhookPath: this.config.cloudWebhookPath,
    });
  }

  async sendMessage(chatId: string, message: string): Promise<boolean> {
    return (await this.sendMessageDetailed(chatId, message)).success;
  }

  async sendMessageDetailed(
    chatId: string,
    message: string
  ): Promise<MessagingSendResult> {
    if (!this.isConnected()) {
      return { success: false, providerMessageIds: [], error: 'transport not ready' };
    }

    const recipient = this.normalizeRecipient(chatId);
    if (!recipient) {
      return {
        success: false,
        providerMessageIds: [],
        error: `unsupported Cloud API recipient: ${chatId}`,
      };
    }

    // Keep each logical reply atomic so a retry cannot duplicate a chunk that
    // the provider already accepted before a later chunk failed.
    const outgoing = [message.trim()].filter(Boolean);
    if (outgoing.length === 0) {
      return { success: true, providerMessageIds: [] };
    }
    const providerMessageIds: string[] = [];

    for (const text of outgoing) {
      const controller = new AbortController();
      const timeout = setTimeout(
        () => controller.abort(),
        this.config.cloudSendTimeoutMs
      );
      timeout.unref();

      try {
        const response = await fetch(
          `https://graph.facebook.com/${encodeURIComponent(this.config.cloudApiVersion)}/${encodeURIComponent(this.config.cloudPhoneNumberId)}/messages`,
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${this.config.cloudAccessToken}`,
              'Content-Type': 'application/json',
              Accept: 'application/json',
            },
            body: JSON.stringify({
              messaging_product: 'whatsapp',
              recipient_type: 'individual',
              to: recipient,
              type: 'text',
              text: { preview_url: false, body: text },
            }),
            signal: controller.signal,
          }
        );

        const raw = await response.text();
        let payload: CloudApiMessageResponse = {};
        if (raw) {
          try {
            payload = JSON.parse(raw) as CloudApiMessageResponse;
          } catch {
            payload = {};
          }
        }

        if (!response.ok) {
          const detail = payload.error?.message || raw.slice(0, 300) || `HTTP ${response.status}`;
          logger.error('WhatsApp Cloud API send failed', {
            status: response.status,
            recipient: this.mask(recipient),
            error: detail,
          });
          return {
            success: false,
            providerMessageIds,
            error: detail,
          };
        }

        for (const item of payload.messages || []) {
          if (item.id) providerMessageIds.push(item.id);
        }
      } catch (error) {
        const detail =
          error instanceof Error && error.name === 'AbortError'
            ? `send timed out after ${this.config.cloudSendTimeoutMs}ms`
            : error instanceof Error
              ? error.message
              : 'unknown send error';
        logger.error('WhatsApp Cloud API send could not complete', {
          recipient: this.mask(recipient),
          error: detail,
        });
        return { success: false, providerMessageIds, error: detail };
      } finally {
        clearTimeout(timeout);
      }
    }

    logger.info('WhatsApp Cloud API message accepted', {
      recipient: this.mask(recipient),
      bubbles: outgoing.length,
      providerMessageIds: providerMessageIds.length,
    });
    return { success: true, providerMessageIds };
  }

  getWebhookPath(): string {
    return this.config.cloudWebhookPath;
  }

  verifyWebhookChallenge(query: URLSearchParams): string | null {
    const mode = query.get('hub.mode');
    const token = query.get('hub.verify_token');
    const challenge = query.get('hub.challenge');
    if (
      mode === 'subscribe' &&
      token === this.config.cloudVerifyToken &&
      challenge
    ) {
      return challenge;
    }
    return null;
  }

  async handleWebhookRequest(
    rawBody: Buffer,
    headers: Record<string, string | string[] | undefined>
  ): Promise<MessagingWebhookResult> {
    if (rawBody.length > this.config.cloudWebhookMaxBodyBytes) {
      return { statusCode: 413, body: { error: 'payload too large' } };
    }

    const signatureHeader = this.firstHeader(headers['x-hub-signature-256']);
    if (!this.isValidSignature(rawBody, signatureHeader)) {
      logger.warn('Rejected WhatsApp webhook with invalid signature');
      return { statusCode: 401, body: { error: 'invalid signature' } };
    }

    let payload: CloudWebhookPayload;
    try {
      payload = JSON.parse(rawBody.toString('utf8')) as CloudWebhookPayload;
    } catch {
      return { statusCode: 400, body: { error: 'invalid json' } };
    }

    if (payload.object !== 'whatsapp_business_account') {
      return { statusCode: 200, body: { accepted: true, ignored: true } };
    }

    let messages = 0;
    let statuses = 0;
    for (const entry of payload.entry || []) {
      for (const change of entry.changes || []) {
        if (change.field !== 'messages' || !change.value) continue;
        const value = change.value;
        const webhookPhoneNumberId = value.metadata?.phone_number_id || '';
        if (
          webhookPhoneNumberId &&
          webhookPhoneNumberId !== this.config.cloudPhoneNumberId
        ) {
          logger.warn('Ignoring WhatsApp webhook for a different phone number', {
            phoneNumberId: this.mask(webhookPhoneNumberId),
          });
          continue;
        }
        const contactNames = new Map<string, string>();
        for (const contact of value.contacts || []) {
          if (contact.wa_id && contact.profile?.name) {
            contactNames.set(contact.wa_id, contact.profile.name);
          }
        }

        for (const rawMessage of value.messages || []) {
          const mapped = this.mapInboundMessage(rawMessage, contactNames);
          if (mapped) {
            messages += 1;
            this.emitMessage(mapped);
          }
        }

        for (const rawStatus of value.statuses || []) {
          const mapped = this.mapDeliveryStatus(rawStatus);
          if (mapped) {
            statuses += 1;
            this.emitDeliveryStatus(mapped);
          }
        }
      }
    }

    logger.debug('WhatsApp webhook processed', { messages, statuses });
    return { statusCode: 200, body: { accepted: true } };
  }

  onMessage(handler: (message: WhatsAppMessage) => void): void {
    this.messageHandlers.push(handler);
  }

  onConnectionStatusChange(handler: (status: ConnectionStatus) => void): void {
    this.statusHandlers.push(handler);
  }

  onDeliveryStatus(handler: (update: MessageDeliveryUpdate) => void): void {
    this.deliveryHandlers.push(handler);
  }

  getConnectionStatus(): ConnectionStatus {
    return this.connectionStatus;
  }

  isConnected(): boolean {
    return this.connectionStatus === ConnectionStatus.READY;
  }

  async disconnect(): Promise<void> {
    this.setStatus(ConnectionStatus.DISCONNECTED);
  }

  async getChatParticipants(_chatId: string): Promise<string[]> {
    return [];
  }

  private mapInboundMessage(
    raw: Record<string, unknown>,
    contactNames: Map<string, string>
  ): WhatsAppMessage | null {
    const id = this.stringValue(raw['id']);
    const fromNumber = this.stringValue(raw['from']);
    const type = this.stringValue(raw['type']);
    if (!id || !fromNumber || !type) return null;

    const mapped = this.extractInboundContent(raw, type);
    if (!mapped) return null;
    const jid = `${fromNumber}@s.whatsapp.net`;
    const timestampSeconds = Number(this.stringValue(raw['timestamp'])) || 0;

    return {
      id,
      from: jid,
      to: jid,
      timestamp: timestampSeconds > 0 ? timestampSeconds * 1000 : Date.now(),
      type: mapped.type,
      content: mapped.content,
      isGroup: false,
      senderName: contactNames.get(fromNumber),
      isFromBot: false,
    };
  }

  private extractInboundContent(
    raw: Record<string, unknown>,
    type: string
  ): Pick<WhatsAppMessage, 'type' | 'content'> | null {
    const nested = (key: string): Record<string, unknown> =>
      this.recordValue(raw[key]);

    if (type === 'text') {
      const body = this.stringValue(nested('text')['body']);
      return body ? { type: 'text', content: body } : null;
    }
    if (type === 'button') {
      const body = this.stringValue(nested('button')['text']);
      return body ? { type: 'text', content: body } : null;
    }
    if (type === 'interactive') {
      const interactive = nested('interactive');
      const button = this.recordValue(interactive['button_reply']);
      const list = this.recordValue(interactive['list_reply']);
      const content =
        this.stringValue(button['title']) ||
        this.stringValue(button['id']) ||
        this.stringValue(list['title']) ||
        this.stringValue(list['id']);
      return content ? { type: 'text', content } : null;
    }
    if (type === 'image') {
      return {
        type: 'image',
        content: this.stringValue(nested('image')['caption']) || '[Image received]',
      };
    }
    if (type === 'video') {
      return {
        type: 'video',
        content: this.stringValue(nested('video')['caption']) || '[Video received]',
      };
    }
    if (type === 'document') {
      const document = nested('document');
      return {
        type: 'document',
        content:
          this.stringValue(document['caption']) ||
          this.stringValue(document['filename']) ||
          '[Document received]',
      };
    }
    if (type === 'audio') return { type: 'audio', content: '[Audio received]' };
    if (type === 'location') return { type: 'location', content: '[Location received]' };
    if (type === 'contacts') return { type: 'contact', content: '[Contact received]' };
    return null;
  }

  private mapDeliveryStatus(
    raw: Record<string, unknown>
  ): MessageDeliveryUpdate | null {
    const providerMessageId = this.stringValue(raw['id']);
    if (!providerMessageId) return null;
    const rawStatus = this.stringValue(raw['status']);
    const status = this.normalizeStatus(rawStatus);
    const errors = Array.isArray(raw['errors']) ? raw['errors'] : [];
    const firstError = errors.length > 0 ? this.recordValue(errors[0]) : {};
    const conversation = this.recordValue(raw['conversation']);
    const pricing = this.recordValue(raw['pricing']);
    const timestampSeconds = Number(this.stringValue(raw['timestamp'])) || 0;

    return {
      providerMessageId,
      status,
      timestamp: timestampSeconds > 0 ? timestampSeconds * 1000 : Date.now(),
      recipientId: this.stringValue(raw['recipient_id']) || undefined,
      conversationId: this.stringValue(conversation['id']) || undefined,
      pricingCategory: this.stringValue(pricing['category']) || undefined,
      errorCode:
        this.stringValue(firstError['code']) ||
        this.stringValue(firstError['error_subcode']) ||
        undefined,
      errorMessage:
        this.stringValue(firstError['title']) ||
        this.stringValue(firstError['message']) ||
        undefined,
    };
  }

  private normalizeStatus(value: string): MessageDeliveryStatus {
    switch (value) {
      case 'sent':
      case 'delivered':
      case 'read':
      case 'failed':
      case 'deleted':
        return value;
      default:
        return 'unknown';
    }
  }

  private isValidSignature(rawBody: Buffer, header: string): boolean {
    if (!header.startsWith('sha256=')) return false;
    const supplied = header.slice('sha256='.length);
    const expected = createHmac('sha256', this.config.cloudAppSecret)
      .update(rawBody)
      .digest('hex');
    if (supplied.length !== expected.length) return false;
    try {
      return timingSafeEqual(Buffer.from(supplied, 'hex'), Buffer.from(expected, 'hex'));
    } catch {
      return false;
    }
  }

  private normalizeRecipient(chatId: string): string | null {
    if (chatId.endsWith('@g.us')) return null;
    const value = chatId.split('@')[0]?.replace(/\D/g, '') || '';
    return value.length >= 8 ? value : null;
  }

  private emitMessage(message: WhatsAppMessage): void {
    for (const handler of this.messageHandlers) {
      try {
        handler(message);
      } catch (error) {
        logger.error('Cloud API message handler failed', {
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    }
  }

  private emitDeliveryStatus(update: MessageDeliveryUpdate): void {
    for (const handler of this.deliveryHandlers) {
      try {
        handler(update);
      } catch (error) {
        logger.error('Cloud API delivery handler failed', {
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    }
  }

  private setStatus(status: ConnectionStatus): void {
    this.connectionStatus = status;
    for (const handler of this.statusHandlers) handler(status);
  }

  private firstHeader(value: string | string[] | undefined): string {
    return Array.isArray(value) ? value[0] || '' : value || '';
  }

  private recordValue(value: unknown): Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  }

  private stringValue(value: unknown): string {
    return typeof value === 'string' || typeof value === 'number'
      ? String(value)
      : '';
  }

  private mask(value: string): string {
    if (value.length <= 4) return '****';
    return `${'*'.repeat(Math.max(4, value.length - 4))}${value.slice(-4)}`;
  }
}
