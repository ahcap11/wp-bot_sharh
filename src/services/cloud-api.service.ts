import {
  ConnectionStatus,
  MessagingConfig,
  MessagingTransport,
  WhatsAppMessage,
} from '../types';
import { logger } from '../utils/logger';

/**
 * WhatsApp Cloud API transport — SCAFFOLD. Not yet active.
 *
 * Implements the same MessagingTransport contract as the Baileys adapter so the
 * rest of the application is unchanged when you switch backends. Activate by
 * setting WHATSAPP_TRANSPORT=cloud once the official number and credentials are
 * ready.
 *
 * Two integration points must be filled in before this is usable:
 *
 * 1. OUTBOUND — `sendMessage` should POST to the Graph API:
 *      POST https://graph.facebook.com/<apiVersion>/<phoneNumberId>/messages
 *      Authorization: Bearer <accessToken>
 *      body: { messaging_product: 'whatsapp', to, type: 'text', text: { body } }
 *
 * 2. INBOUND — the Cloud API delivers messages via an HTTP webhook, not a
 *    socket. A webhook route (GET for verification using `verifyToken`, POST for
 *    message payloads) must call `handleWebhookEvent(payload)` below, which maps
 *    the payload to WhatsAppMessage and invokes the registered handler. Wire that
 *    route into the existing health/HTTP server in index.ts.
 *
 * Until both are implemented, constructing and using this transport throws, so a
 * misconfiguration fails loudly instead of silently dropping messages.
 */
export class CloudApiTransport implements MessagingTransport {
  private readonly config: MessagingConfig;
  private connectionStatus: ConnectionStatus = ConnectionStatus.DISCONNECTED;
  private messageHandler: ((message: WhatsAppMessage) => void) | null = null;
  private statusHandler: ((status: ConnectionStatus) => void) | null = null;

  constructor(config: MessagingConfig) {
    this.config = config;
  }

  async initialize(): Promise<void> {
    if (
      !this.config.cloudPhoneNumberId ||
      !this.config.cloudAccessToken ||
      !this.config.cloudVerifyToken
    ) {
      throw new Error(
        'CloudApiTransport requires WHATSAPP_CLOUD_PHONE_NUMBER_ID, ' +
          'WHATSAPP_CLOUD_ACCESS_TOKEN and WHATSAPP_CLOUD_VERIFY_TOKEN to be set.'
      );
    }
    // The Cloud API has no persistent connection to open; readiness is implicit
    // once the webhook is registered with Meta. Mark ready and rely on webhooks.
    this.setStatus(ConnectionStatus.READY);
    logger.warn(
      'CloudApiTransport.initialize called, but the Cloud API adapter is a ' +
        'scaffold. Implement sendMessage and the inbound webhook before use.'
    );
  }

  async sendMessage(_chatId: string, _message: string): Promise<boolean> {
    throw new Error(
      'CloudApiTransport.sendMessage is not implemented yet. ' +
        'Implement the Graph API POST described in this file.'
    );
  }

  /**
   * Entry point for the inbound webhook route to push a mapped message in.
   * Implement the payload mapping when wiring the webhook.
   */
  handleWebhookEvent(_payload: unknown): void {
    throw new Error(
      'CloudApiTransport.handleWebhookEvent is not implemented yet. ' +
        'Map the Cloud API webhook payload to WhatsAppMessage here.'
    );
  }

  onMessage(handler: (message: WhatsAppMessage) => void): void {
    this.messageHandler = handler;
  }

  onConnectionStatusChange(handler: (status: ConnectionStatus) => void): void {
    this.statusHandler = handler;
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
    // The Cloud API does not expose group participant lists the same way.
    return [];
  }

  private setStatus(status: ConnectionStatus): void {
    this.connectionStatus = status;
    if (this.statusHandler) {
      this.statusHandler(status);
    }
  }

  /** Reserved for the webhook implementation to deliver mapped messages. */
  protected emitMessage(message: WhatsAppMessage): void {
    if (this.messageHandler) {
      this.messageHandler(message);
    }
  }
}
