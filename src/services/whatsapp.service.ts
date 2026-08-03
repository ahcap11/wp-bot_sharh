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
} from '../types';
import { logger } from '../utils/logger';

/**
 * WhatsApp transport backed by Baileys (WhatsApp Web).
 * Implements the backend-agnostic MessagingTransport contract.
 */
export class WhatsAppService implements MessagingTransport {
  private sock: WASocket | null = null;
  private connectionStatus: ConnectionStatus = ConnectionStatus.DISCONNECTED;
  private messageHandlers: Array<(message: WhatsAppMessage) => void> = [];
  private statusHandlers: Array<(status: ConnectionStatus) => void> = [];
  private currentQr: string | null = null;

  constructor() {
    logger.info('WhatsApp Service initialized');
  }

  /**
   * Initialize WhatsApp connection
   */
  async initialize(): Promise<void> {
    try {
      logger.info('Initializing WhatsApp connection...');
      this.updateConnectionStatus(ConnectionStatus.CONNECTING);

      const authDir =
        process.env['WHATSAPP_AUTH_DIR'] || '.whatsapp-session';
      const { state, saveCreds } = await useMultiFileAuthState(authDir);

      // Use the current WhatsApp Web protocol version. A stale bundled version
      // causes WhatsApp to reject the handshake with a 405 "Connection Failure"
      // loop before any QR is issued. Fall back to the bundled version if the
      // lookup fails.
      let version: [number, number, number] | undefined;
      try {
        const latest = await fetchLatestBaileysVersion();
        version = latest.version;
        logger.info('Using WhatsApp Web version', {
          version: latest.version,
          isLatest: latest.isLatest,
        });
      } catch (versionError) {
        logger.warn('Could not fetch latest WhatsApp Web version; using bundled', {
          error:
            versionError instanceof Error
              ? versionError.message
              : 'Unknown error',
        });
      }

      this.sock = makeWASocket({
        ...(version ? { version } : {}),
        auth: state,
        printQRInTerminal: false,
        browser: Browsers.ubuntu('Chrome'),
      });

      // Handle connection updates
      this.sock.ev.on('connection.update', async update => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
          this.currentQr = qr;
          logger.info(
            'QR Code received — open /qr on the health port to scan, or use the log QR below'
          );
          qrcode.generate(qr, { small: true });
        }

        if (connection === 'close') {
          const shouldReconnect =
            (lastDisconnect?.error as any)?.output?.statusCode !==
            DisconnectReason.loggedOut;

          logger.info('Connection closed', {
            reason: lastDisconnect?.error,
            shouldReconnect,
          });

          if (shouldReconnect) {
            this.updateConnectionStatus(ConnectionStatus.CONNECTING);
            // Back off before reconnecting so we don't hammer WhatsApp, which
            // can trigger 405 rate-limiting and a tight failure loop.
            await this.delay(5000);
            await this.initialize();
          } else {
            this.updateConnectionStatus(ConnectionStatus.DISCONNECTED);
          }
        } else if (connection === 'open') {
          this.currentQr = null;
          logger.info('WhatsApp connection established');
          this.updateConnectionStatus(ConnectionStatus.READY);
        }
      });

      // Handle credentials update
      this.sock.ev.on('creds.update', saveCreds);

      // Handle messages
      this.sock.ev.on('messages.upsert', async m => {
        const msg = m.messages[0];

        if (msg && !msg.key.fromMe && msg.message) {
          const whatsappMessage = this.parseMessage(msg);
          if (whatsappMessage) {
            logger.info('Message received', {
              from: whatsappMessage.from,
              type: whatsappMessage.type,
              length: whatsappMessage.content.length,
            });

            // Notify all message handlers
            this.messageHandlers.forEach(handler => {
              try {
                handler(whatsappMessage);
              } catch (error) {
                logger.error('Error in message handler', {
                  error:
                    error instanceof Error ? error.message : 'Unknown error',
                });
              }
            });
          }
        }
      });

      logger.info('WhatsApp service initialized successfully');
    } catch (error) {
      logger.error('Failed to initialize WhatsApp service', {
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      this.updateConnectionStatus(ConnectionStatus.DISCONNECTED);
      throw error;
    }
  }

  /**
   * Send message to a specific chat
   */
  async sendMessage(chatId: string, message: string): Promise<boolean> {
    if (!this.sock || this.connectionStatus !== ConnectionStatus.READY) {
      logger.error('WhatsApp not connected');
      return false;
    }

    // The model separates distinct chat bubbles with a line containing '---'.
    // Send them as separate short messages with a typing indicator so the
    // conversation reads like a human on WhatsApp instead of one wall of text.
    const bubbles = message
      .split(/\n?\s*---\s*\n?/g)
      .map(part => part.trim())
      .filter(Boolean);
    const outgoing = bubbles.length > 0 ? bubbles : [message];

    try {
      for (let i = 0; i < outgoing.length; i++) {
        const text = outgoing[i] as string;
        try {
          await this.sock.sendPresenceUpdate('composing', chatId);
        } catch {
          // Presence is best-effort; never block sending on it.
        }
        await this.delay(Math.min(1200, 300 + text.length * 12));
        await this.sock.sendMessage(chatId, { text });
        if (i < outgoing.length - 1) {
          await this.delay(400);
        }
      }
      try {
        await this.sock.sendPresenceUpdate('paused', chatId);
      } catch {
        // best-effort
      }
      logger.info('Message sent successfully', {
        chatId,
        bubbles: outgoing.length,
        messageLength: message.length,
      });
      return true;
    } catch (error) {
      logger.error('Failed to send message', {
        chatId,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      return false;
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Parse WhatsApp message to our format
   */
  private parseMessage(msg: proto.IWebMessageInfo): WhatsAppMessage | null {
    try {
      const messageType = this.getMessageType(msg.message || undefined);
      const content = this.extractMessageContent(msg.message || undefined);

      if (!content) return null;

      const isGroup = msg.key.remoteJid?.endsWith('@g.us') || false;
      const groupId = isGroup ? msg.key.remoteJid : undefined;

      return {
        id: msg.key.id || '',
        from: msg.key.participant || msg.key.remoteJid || '',
        to: msg.key.remoteJid || '',
        timestamp: msg.messageTimestamp
          ? (msg.messageTimestamp as number) * 1000
          : Date.now(),
        type: messageType,
        content,
        isGroup,
        groupId: groupId || undefined,
        senderName: msg.pushName || undefined,
        isFromBot: false,
      };
    } catch (error) {
      logger.error('Error parsing message', {
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      return null;
    }
  }

  /**
   * Extract message content based on type
   */
  private extractMessageContent(
    message: proto.IMessage | undefined
  ): string | null {
    if (!message) return null;

    if (message.conversation) return message.conversation;
    if (message.extendedTextMessage?.text)
      return message.extendedTextMessage.text;
    if (message.imageMessage?.caption) return message.imageMessage.caption;
    if (message.videoMessage?.caption) return message.videoMessage.caption;
    if (message.documentMessage?.title) return message.documentMessage.title;

    return null;
  }

  /**
   * Get message type
   */
  private getMessageType(
    message: proto.IMessage | undefined
  ): WhatsAppMessage['type'] {
    if (!message) return 'text';

    if (message.conversation || message.extendedTextMessage) return 'text';
    if (message.imageMessage) return 'image';
    if (message.videoMessage) return 'video';
    if (message.audioMessage) return 'audio';
    if (message.documentMessage) return 'document';
    if (message.locationMessage) return 'location';
    if (message.contactMessage) return 'contact';

    return 'text';
  }

  /**
   * Add message handler
   */
  onMessage(handler: (message: WhatsAppMessage) => void): void {
    this.messageHandlers.push(handler);
  }

  /**
   * Add connection status handler
   */
  onConnectionStatusChange(handler: (status: ConnectionStatus) => void): void {
    this.statusHandlers.push(handler);
  }

  /**
   * Update connection status and notify handlers
   */
  private updateConnectionStatus(status: ConnectionStatus): void {
    this.connectionStatus = status;
    logger.info('Connection status changed', { status });

    this.statusHandlers.forEach(handler => {
      try {
        handler(status);
      } catch (error) {
        logger.error('Error in status handler', {
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    });
  }

  /**
   * Get current connection status
   */
  getConnectionStatus(): ConnectionStatus {
    return this.connectionStatus;
  }

  /** Latest pending QR string (null once linked or before one is issued). */
  getCurrentQr(): string | null {
    return this.currentQr;
  }

  /**
   * Check if WhatsApp is connected
   */
  isConnected(): boolean {
    return this.connectionStatus === ConnectionStatus.READY;
  }

  /**
   * Disconnect WhatsApp
   */
  async disconnect(): Promise<void> {
    if (this.sock) {
      await this.sock.logout();
      this.sock = null;
    }
    this.updateConnectionStatus(ConnectionStatus.DISCONNECTED);
    logger.info('WhatsApp disconnected');
  }

  /**
   * Get chat participants (for group chats)
   */
  async getChatParticipants(chatId: string): Promise<string[]> {
    if (!this.sock || !chatId.endsWith('@g.us')) {
      return [];
    }

    try {
      const groupMetadata = await this.sock.groupMetadata(chatId);
      return groupMetadata.participants.map(p => p.id);
    } catch (error) {
      logger.error('Failed to get chat participants', {
        chatId,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      return [];
    }
  }
}
