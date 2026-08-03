import {
  default as makeWASocket,
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  Browsers,
  WASocket,
  proto,
} from '@whiskeysockets/baileys';
import qrcode from 'qrcode-terminal';
import {
  WhatsAppMessage,
  ConnectionStatus,
  MessagingTransport,
  MessagingSendResult,
  MessagingConfig,
} from '../types';
import { logger } from '../utils/logger';

/**
 * Pilot WhatsApp transport backed by Baileys (WhatsApp Web multi-device).
 *
 * The transport is intentionally isolated behind MessagingTransport so it can
 * be replaced by the official Cloud API later without touching funnel or SHARH
 * integration logic.
 */
export class WhatsAppService implements MessagingTransport {
  private sock: WASocket | null = null;
  private connectionStatus: ConnectionStatus = ConnectionStatus.DISCONNECTED;
  private readonly messageHandlers: Array<(message: WhatsAppMessage) => void> = [];
  private readonly statusHandlers: Array<(status: ConnectionStatus) => void> = [];
  private currentQr: string | null = null;
  private initializePromise: Promise<void> | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectAttempt = 0;
  private generation = 0;
  private stopping = false;

  constructor(private readonly config: MessagingConfig) {
    logger.info('Baileys WhatsApp service initialized', {
      authDir: this.config.baileysAuthDir,
    });
  }

  /** Initialize or reconnect the WhatsApp Web session. */
  async initialize(): Promise<void> {
    if (this.initializePromise) {
      return this.initializePromise;
    }

    this.stopping = false;
    this.initializePromise = this.openConnection().finally(() => {
      this.initializePromise = null;
    });
    return this.initializePromise;
  }

  private async openConnection(): Promise<void> {
    const generation = ++this.generation;

    try {
      logger.info('Initializing Baileys WhatsApp connection', {
        generation,
        authDir: this.config.baileysAuthDir,
      });
      this.updateConnectionStatus(ConnectionStatus.CONNECTING);

      const { state, saveCreds } = await useMultiFileAuthState(
        this.config.baileysAuthDir
      );

      const version = await this.resolveProtocolVersion();
      const sock = makeWASocket({
        ...(version ? { version } : {}),
        auth: state,
        printQRInTerminal: false,
        browser: Browsers.ubuntu('Chrome'),
        syncFullHistory: false,
        markOnlineOnConnect: false,
      });
      this.sock = sock;

      sock.ev.on('connection.update', update => {
        if (!this.isCurrentConnection(generation, sock)) return;
        void this.handleConnectionUpdate(update, generation, sock);
      });

      sock.ev.on('creds.update', async () => {
        if (!this.isCurrentConnection(generation, sock)) return;
        try {
          await saveCreds();
        } catch (error) {
          logger.error('Failed to persist Baileys credentials', {
            error: error instanceof Error ? error.message : 'Unknown error',
          });
        }
      });

      sock.ev.on('messages.upsert', upsert => {
        if (!this.isCurrentConnection(generation, sock)) return;
        if (upsert.type !== 'notify') {
          logger.debug('Ignoring non-live Baileys message batch', {
            type: upsert.type,
            count: upsert.messages.length,
          });
          return;
        }

        for (const msg of upsert.messages) {
          if (!msg || msg.key.fromMe || !msg.message) continue;
          if (!this.isSupportedRemoteJid(msg.key.remoteJid || '')) continue;

          const whatsappMessage = this.parseMessage(msg);
          if (!whatsappMessage) continue;

          logger.info('Message received', {
            from: whatsappMessage.from,
            type: whatsappMessage.type,
            length: whatsappMessage.content.length,
          });
          this.notifyMessageHandlers(whatsappMessage);
        }
      });

      logger.info('Baileys socket created successfully', { generation });
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'Unknown error';
      logger.error('Failed to initialize Baileys WhatsApp service', {
        generation,
        error: detail,
      });
      if (generation === this.generation) {
        this.sock = null;
        this.currentQr = null;
        this.updateConnectionStatus(ConnectionStatus.DISCONNECTED);
        this.scheduleReconnect('initialization failure');
      }
    }
  }

  private async resolveProtocolVersion(): Promise<
    [number, number, number] | undefined
  > {
    let timeout: NodeJS.Timeout | null = null;
    try {
      const latest = await Promise.race([
        fetchLatestBaileysVersion(),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(
            () => reject(new Error('version lookup timed out')),
            8000
          );
          timeout.unref?.();
        }),
      ]);
      logger.info('Using WhatsApp Web protocol version', {
        version: latest.version,
        isLatest: latest.isLatest,
      });
      return latest.version;
    } catch (error) {
      logger.warn('Could not fetch latest WhatsApp Web version; using bundled', {
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      return undefined;
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  private async handleConnectionUpdate(
    update: {
      connection?: 'open' | 'close' | 'connecting';
      lastDisconnect?: { error?: unknown };
      qr?: string;
    },
    generation: number,
    sock: WASocket
  ): Promise<void> {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      this.currentQr = qr;
      this.updateConnectionStatus(ConnectionStatus.AUTHENTICATING);
      logger.info(
        'WhatsApp linking QR received. Open /qr?token=<QR_ACCESS_TOKEN> or scan the terminal QR.'
      );
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'open') {
      this.currentQr = null;
      this.reconnectAttempt = 0;
      this.clearReconnectTimer();
      logger.info('Baileys WhatsApp connection established', { generation });
      this.updateConnectionStatus(ConnectionStatus.READY);
      return;
    }

    if (connection !== 'close') return;

    this.currentQr = null;
    if (this.isCurrentConnection(generation, sock)) {
      this.sock = null;
    }

    const statusCode = this.getDisconnectStatusCode(lastDisconnect?.error);
    const loggedOut = statusCode === DisconnectReason.loggedOut;
    const shouldReconnect = !this.stopping && !loggedOut;

    logger.warn('Baileys WhatsApp connection closed', {
      generation,
      statusCode,
      loggedOut,
      shouldReconnect,
    });

    if (loggedOut) {
      this.updateConnectionStatus(ConnectionStatus.DISCONNECTED);
      logger.error(
        'WhatsApp session was logged out. Clear the auth directory only if necessary, then link the device again.'
      );
      return;
    }

    if (shouldReconnect) {
      this.updateConnectionStatus(ConnectionStatus.CONNECTING);
      this.scheduleReconnect('connection closed');
    } else {
      this.updateConnectionStatus(ConnectionStatus.DISCONNECTED);
    }
  }

  private scheduleReconnect(reason: string): void {
    if (this.stopping || this.reconnectTimer) return;

    const exponent = Math.min(this.reconnectAttempt, 8);
    const baseDelay = Math.min(
      this.config.baileysReconnectMaxDelayMs,
      this.config.baileysReconnectBaseDelayMs * 2 ** exponent
    );
    const jitter = Math.floor(baseDelay * 0.2 * Math.random());
    const delayMs = Math.min(
      this.config.baileysReconnectMaxDelayMs,
      baseDelay + jitter
    );
    this.reconnectAttempt += 1;

    logger.info('Scheduling Baileys reconnect', {
      reason,
      attempt: this.reconnectAttempt,
      delayMs,
    });

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.stopping) {
        void this.initialize();
      }
    }, delayMs);
    this.reconnectTimer.unref?.();
  }

  async sendMessage(chatId: string, message: string): Promise<boolean> {
    return (await this.sendMessageDetailed(chatId, message)).success;
  }

  async sendMessageDetailed(
    chatId: string,
    message: string
  ): Promise<MessagingSendResult> {
    const sock = this.sock;
    if (!sock || this.connectionStatus !== ConnectionStatus.READY) {
      logger.error('WhatsApp is not connected');
      return {
        success: false,
        providerMessageIds: [],
        error: 'WhatsApp is not connected',
      };
    }

    const bubbles = message
      .split(/\n?\s*---\s*\n?/g)
      .map(part => part.trim())
      .filter(Boolean);
    const outgoing = bubbles.length > 0 ? bubbles : [message];
    const providerMessageIds: string[] = [];

    try {
      for (let i = 0; i < outgoing.length; i++) {
        const text = outgoing[i] as string;
        try {
          await sock.sendPresenceUpdate('composing', chatId);
        } catch {
          // Presence is best-effort.
        }
        await this.delay(Math.min(1200, 300 + text.length * 12));
        const sent = await sock.sendMessage(chatId, { text });
        if (sent?.key?.id) providerMessageIds.push(sent.key.id);
        if (i < outgoing.length - 1) await this.delay(400);
      }
      try {
        await sock.sendPresenceUpdate('paused', chatId);
      } catch {
        // Presence is best-effort.
      }
      logger.info('Message sent successfully', {
        chatId,
        bubbles: outgoing.length,
        messageLength: message.length,
        providerMessageIds: providerMessageIds.length,
      });
      return { success: true, providerMessageIds };
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'Unknown error';
      logger.error('Failed to send message', { chatId, error: detail });
      return { success: false, providerMessageIds, error: detail };
    }
  }

  private parseMessage(msg: proto.IWebMessageInfo): WhatsAppMessage | null {
    try {
      const messageType = this.getMessageType(msg.message || undefined);
      const content = this.extractMessageContent(msg.message || undefined);
      if (!content) return null;

      const remoteJid = msg.key.remoteJid || '';
      const isGroup = remoteJid.endsWith('@g.us');
      const from = isGroup
        ? msg.key.participant || remoteJid
        : remoteJid;

      return {
        id: msg.key.id || '',
        from,
        to: remoteJid,
        timestamp: this.toTimestampMs(msg.messageTimestamp),
        type: messageType,
        content,
        isGroup,
        ...(isGroup ? { groupId: remoteJid } : {}),
        ...(msg.pushName ? { senderName: msg.pushName } : {}),
        isFromBot: false,
      };
    } catch (error) {
      logger.error('Error parsing Baileys message', {
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      return null;
    }
  }

  private extractMessageContent(
    message: proto.IMessage | undefined
  ): string | null {
    if (!message) return null;
    if (message.conversation) return message.conversation;
    if (message.extendedTextMessage?.text)
      return message.extendedTextMessage.text;
    if (message.imageMessage?.caption) return message.imageMessage.caption;
    if (message.videoMessage?.caption) return message.videoMessage.caption;
    if (message.documentMessage?.caption)
      return message.documentMessage.caption;
    if (message.documentMessage?.title) return message.documentMessage.title;
    if (message.buttonsResponseMessage?.selectedDisplayText)
      return message.buttonsResponseMessage.selectedDisplayText;
    if (message.listResponseMessage?.title)
      return message.listResponseMessage.title;
    if (message.templateButtonReplyMessage?.selectedDisplayText)
      return message.templateButtonReplyMessage.selectedDisplayText;
    return null;
  }

  private getMessageType(
    message: proto.IMessage | undefined
  ): WhatsAppMessage['type'] {
    if (!message) return 'text';
    if (
      message.conversation ||
      message.extendedTextMessage ||
      message.buttonsResponseMessage ||
      message.listResponseMessage ||
      message.templateButtonReplyMessage
    )
      return 'text';
    if (message.imageMessage) return 'image';
    if (message.videoMessage) return 'video';
    if (message.audioMessage) return 'audio';
    if (message.documentMessage) return 'document';
    if (message.locationMessage) return 'location';
    if (message.contactMessage || message.contactsArrayMessage) return 'contact';
    return 'text';
  }

  onMessage(handler: (message: WhatsAppMessage) => void): void {
    this.messageHandlers.push(handler);
  }

  onConnectionStatusChange(handler: (status: ConnectionStatus) => void): void {
    this.statusHandlers.push(handler);
  }

  private notifyMessageHandlers(message: WhatsAppMessage): void {
    for (const handler of this.messageHandlers) {
      try {
        handler(message);
      } catch (error) {
        logger.error('Error in WhatsApp message handler', {
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    }
  }

  private updateConnectionStatus(status: ConnectionStatus): void {
    if (this.connectionStatus === status) return;
    this.connectionStatus = status;
    logger.info('Connection status changed', { status });

    for (const handler of this.statusHandlers) {
      try {
        handler(status);
      } catch (error) {
        logger.error('Error in connection status handler', {
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    }
  }

  getConnectionStatus(): ConnectionStatus {
    return this.connectionStatus;
  }

  getCurrentQr(): string | null {
    return this.currentQr;
  }

  isConnected(): boolean {
    return this.connectionStatus === ConnectionStatus.READY;
  }

  /**
   * Stop the socket without logging the linked device out. Calling logout here
   * would invalidate the saved session on every deployment or graceful restart.
   */
  async disconnect(): Promise<void> {
    this.stopping = true;
    this.clearReconnectTimer();
    this.currentQr = null;
    this.generation += 1;

    const sock = this.sock;
    this.sock = null;
    if (sock) {
      try {
        const closeable = sock as unknown as {
          end?: (error?: Error) => void;
          ws?: { close?: () => void };
        };
        if (typeof closeable.end === 'function') {
          closeable.end(new Error('Application shutdown'));
        } else {
          closeable.ws?.close?.();
        }
      } catch (error) {
        logger.warn('Error while closing Baileys socket', {
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    }

    this.updateConnectionStatus(ConnectionStatus.DISCONNECTED);
    logger.info('Baileys WhatsApp socket stopped; session credentials preserved');
  }

  async getChatParticipants(chatId: string): Promise<string[]> {
    if (!this.sock || !chatId.endsWith('@g.us')) return [];

    try {
      const groupMetadata = await this.sock.groupMetadata(chatId);
      return groupMetadata.participants.map(participant => participant.id);
    } catch (error) {
      logger.error('Failed to get chat participants', {
        chatId,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      return [];
    }
  }

  private isCurrentConnection(generation: number, sock: WASocket): boolean {
    return generation === this.generation && sock === this.sock;
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private getDisconnectStatusCode(error: unknown): number | undefined {
    if (!error || typeof error !== 'object') return undefined;
    const record = error as Record<string, unknown>;
    const output = record['output'];
    if (output && typeof output === 'object') {
      const statusCode = (output as Record<string, unknown>)['statusCode'];
      if (typeof statusCode === 'number') return statusCode;
    }
    const data = record['data'];
    if (data && typeof data === 'object') {
      const statusCode = (data as Record<string, unknown>)['statusCode'];
      if (typeof statusCode === 'number') return statusCode;
    }
    return undefined;
  }

  private isSupportedRemoteJid(remoteJid: string): boolean {
    if (!remoteJid) return false;
    if (remoteJid === 'status@broadcast' || remoteJid.endsWith('@broadcast'))
      return false;
    if (remoteJid.endsWith('@newsletter')) return false;
    return remoteJid.endsWith('@s.whatsapp.net') || remoteJid.endsWith('@g.us');
  }

  private toTimestampMs(value: proto.IWebMessageInfo['messageTimestamp']): number {
    if (typeof value === 'number') return value * 1000;
    if (typeof value === 'string') {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed * 1000 : Date.now();
    }
    if (value && typeof value === 'object') {
      const maybeLong = value as unknown as { toNumber?: () => number };
      if (typeof maybeLong.toNumber === 'function') {
        const parsed = maybeLong.toNumber();
        return Number.isFinite(parsed) ? parsed * 1000 : Date.now();
      }
    }
    return Date.now();
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
