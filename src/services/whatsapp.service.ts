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
  private recoveryPromise: Promise<void> | null = null;
  private readonly messageCache: Map<string, proto.IMessage> = new Map();
  private readonly maxMessageCacheEntries = 500;

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
        // Baileys can otherwise leave an internal query unresolved indefinitely,
        // which makes a socket look connected while sendMessage never returns.
        // Keep these explicit instead of relying on version-specific defaults.
        connectTimeoutMs: 30000,
        defaultQueryTimeoutMs: 30000,
        keepAliveIntervalMs: 25000,
        retryRequestDelayMs: 500,
        // Baileys can ask for the original message while recovering encryption
        // state or retrying delivery. Keeping a small in-memory cache prevents a
        // retry request from turning into another silent send failure.
        getMessage: async (key: { remoteJid?: string | null; id?: string | null }) =>
          this.getCachedMessage(key.remoteJid || '', key.id || ''),
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

      sock.ev.on('messages.upsert', async upsert => {
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

          const routing = await this.resolveMessageRouting(msg);
          if (!routing || !this.isSupportedRemoteJid(routing.replyJid)) {
            logger.warn('Ignoring Baileys message with unsupported sender JID', {
              remoteJid: msg.key.remoteJid || null,
              remoteJidAlt: this.getKeyString(msg, 'remoteJidAlt'),
              senderPn: this.getKeyString(msg, 'senderPn'),
            });
            continue;
          }

          this.cacheMessage(msg);
          const whatsappMessage = this.parseMessage(msg, routing);
          if (!whatsappMessage) {
            logger.warn('Ignoring unsupported or empty Baileys message', {
              remoteJid: msg.key.remoteJid || null,
              messageKeys: Object.keys(msg.message || {}),
            });
            continue;
          }

          logger.info('Message received', {
            from: whatsappMessage.from,
            replyJid: whatsappMessage.to,
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
    // Baileys' bundled protocol version is the stable default. Looking up the
    // latest WhatsApp Web version on every boot adds an unnecessary external
    // dependency and can pair an older Baileys build with a newer protocol.
    // Keep live lookup as an explicit diagnostic escape hatch only.
    if (process.env['BAILEYS_FETCH_LATEST_VERSION'] !== 'true') {
      return undefined;
    }

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
      logger.warn('Using explicitly requested live WhatsApp Web protocol version', {
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
    const first = await this.sendMessageAttempt(chatId, message);
    if (first.success || this.stopping) return first;

    // A Baileys socket can remain marked READY even when its internal query
    // path is stuck. Recycle it once and retry the reply instead of silently
    // losing the customer's message.
    logger.warn('Recovering WhatsApp socket after send failure', {
      chatId,
      error: first.error || 'unknown send failure',
    });
    const recovered = await this.recoverConnection('send failure');
    if (!recovered) return first;

    const retry = await this.sendMessageAttempt(chatId, message);
    if (!retry.success) {
      logger.error('WhatsApp reply failed after socket recovery', {
        chatId,
        error: retry.error || 'unknown send failure',
      });
    }
    return retry;
  }

  private async sendMessageAttempt(
    chatId: string,
    message: string
  ): Promise<MessagingSendResult> {
    const sock = this.sock;
    if (!sock || this.connectionStatus !== ConnectionStatus.READY) {
      return {
        success: false,
        providerMessageIds: [],
        error: 'WhatsApp is not connected',
      };
    }

    // Keep each logical reply atomic. Splitting one reply into several provider
    // sends creates a retry trap: an early chunk may be delivered before a later
    // chunk fails, then socket recovery would resend the entire reply and
    // duplicate the earlier chunk. Funnel replies are intentionally concise, so
    // one provider send is both simpler for the customer and safer to retry.
    const outgoing = [message.trim()].filter(Boolean);
    if (outgoing.length === 0) {
      return { success: true, providerMessageIds: [] };
    }
    const providerMessageIds: string[] = [];

    try {
      for (let i = 0; i < outgoing.length; i++) {
        const text = outgoing[i] as string;
        try {
          await this.withTimeout(
            sock.sendPresenceUpdate('composing', chatId),
            5000,
            'WhatsApp presence update timed out'
          );
        } catch {
          // Presence is best-effort and must never block the actual reply.
        }
        await this.delay(Math.min(1200, 300 + text.length * 12));
        const sent = (await this.withTimeout(
          sock.sendMessage(chatId, { text }),
          35000,
          'WhatsApp send timed out'
        )) as proto.IWebMessageInfo | undefined;
        if (sent?.key?.id) providerMessageIds.push(sent.key.id);
        if (sent) this.cacheMessage(sent);
        if (i < outgoing.length - 1) await this.delay(400);
      }
      try {
        await this.withTimeout(
          sock.sendPresenceUpdate('paused', chatId),
          5000,
          'WhatsApp presence update timed out'
        );
      } catch {
        // Presence is best-effort and must never block completion.
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

  private async recoverConnection(reason: string): Promise<boolean> {
    if (this.stopping) return false;
    if (this.recoveryPromise) {
      await this.recoveryPromise;
      return this.connectionStatus === ConnectionStatus.READY;
    }

    this.recoveryPromise = (async () => {
      this.clearReconnectTimer();
      const oldSock = this.sock;
      this.sock = null;
      this.generation += 1;
      this.updateConnectionStatus(ConnectionStatus.CONNECTING);

      if (oldSock) {
        try {
          const closeable = oldSock as unknown as {
            end?: (error?: Error) => void;
            ws?: { close?: () => void };
          };
          if (typeof closeable.end === 'function') {
            closeable.end(new Error(`Transport recovery: ${reason}`));
          } else {
            closeable.ws?.close?.();
          }
        } catch (error) {
          logger.warn('Error while recycling Baileys socket', {
            error: error instanceof Error ? error.message : 'Unknown error',
          });
        }
      }

      await this.openConnection();
      await this.waitForReady(20000);
    })().finally(() => {
      this.recoveryPromise = null;
    });

    try {
      await this.recoveryPromise;
    } catch (error) {
      logger.error('WhatsApp socket recovery failed', {
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
    return this.connectionStatus === ConnectionStatus.READY;
  }

  private async waitForReady(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!this.stopping && Date.now() < deadline) {
      if (this.connectionStatus === ConnectionStatus.READY && this.sock) return;
      await this.delay(250);
    }
    throw new Error(`WhatsApp did not become ready within ${timeoutMs}ms`);
  }

  private async withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    message: string
  ): Promise<T> {
    let timer: NodeJS.Timeout | null = null;
    try {
      return await Promise.race([
        promise,
        new Promise<T>((_, reject) => {
          timer = setTimeout(() => reject(new Error(message)), timeoutMs);
          timer.unref?.();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private messageCacheKey(remoteJid: string, messageId: string): string {
    return `${remoteJid}:${messageId}`;
  }

  private cacheMessage(message: proto.IWebMessageInfo): void {
    const remoteJid = message.key.remoteJid || '';
    const messageId = message.key.id || '';
    if (!remoteJid || !messageId || !message.message) return;
    this.messageCache.set(
      this.messageCacheKey(remoteJid, messageId),
      message.message
    );
    while (this.messageCache.size > this.maxMessageCacheEntries) {
      const oldest = this.messageCache.keys().next().value;
      if (!oldest) break;
      this.messageCache.delete(oldest);
    }
  }

  private async getCachedMessage(
    remoteJid: string,
    messageId: string
  ): Promise<proto.IMessage | undefined> {
    return this.messageCache.get(this.messageCacheKey(remoteJid, messageId));
  }

  private parseMessage(
    msg: proto.IWebMessageInfo,
    routing: {
      identityJid: string;
      replyJid: string;
      isGroup: boolean;
      identityAliases: string[];
    }
  ): WhatsAppMessage | null {
    try {
      const unwrapped = this.unwrapMessage(msg.message || undefined);
      const messageType = this.getMessageType(unwrapped);
      const extractedContent = this.extractMessageContent(unwrapped);
      const mediaOnly = !extractedContent && messageType !== 'text';
      const content =
        extractedContent || (mediaOnly ? this.mediaOnlyLabel(messageType) : null);
      if (!content) return null;

      return {
        id: msg.key.id || '',
        from: routing.identityJid,
        to: routing.replyJid,
        timestamp: this.toTimestampMs(msg.messageTimestamp),
        type: messageType,
        content,
        isGroup: routing.isGroup,
        ...(routing.isGroup ? { groupId: routing.replyJid } : {}),
        ...(routing.identityAliases.length
          ? { identityAliases: routing.identityAliases }
          : {}),
        ...(mediaOnly ? { mediaOnly: true } : {}),
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

  private async resolveMessageRouting(
    msg: proto.IWebMessageInfo
  ): Promise<{
    identityJid: string;
    replyJid: string;
    isGroup: boolean;
    identityAliases: string[];
  } | null> {
    const remoteJid = msg.key.remoteJid || '';
    if (!remoteJid) return null;

    const isGroup = remoteJid.endsWith('@g.us');
    if (isGroup) {
      const participant =
        this.firstPhoneJid(
          this.getKeyString(msg, 'participantAlt'),
          this.getKeyString(msg, 'participantPn'),
          this.getKeyString(msg, 'senderPn'),
          msg.key.participant || ''
        ) || msg.key.participant || remoteJid;
      return {
        identityJid: participant,
        replyJid: remoteJid,
        isGroup: true,
        identityAliases: [],
      };
    }

    // Recent WhatsApp/Baileys sessions may deliver private messages using a
    // Linked Identity JID (@lid). Keep the actual incoming conversation JID as
    // the reply target, but use a phone-number JID for CRM identity when the
    // alternate PN fields are present.
    const alternateJids = [
      this.getKeyString(msg, 'remoteJidAlt'),
      this.getKeyString(msg, 'senderPn'),
      this.getKeyString(msg, 'participantPn'),
      this.getKeyString(msg, 'participantAlt'),
    ]
      .map(value => this.normalizeDirectIdentityJid(value))
      .filter((value): value is string => Boolean(value));
    let phoneJid = this.firstPhoneJid(...alternateJids, remoteJid);

    // LID deliberately hides the phone number. If the current message does not
    // include the alternate PN, make one cheap lookup in Baileys' *local learned
    // mapping* before showing the CRM as phone-unknown. This never guesses a
    // number and does not add a question to the customer funnel.
    if (!phoneJid && this.isLidIdentityJid(remoteJid)) {
      phoneJid = await this.resolveLearnedPhoneJid(remoteJid);
    }

    const identityAliases = Array.from(
      new Set(
        [remoteJid, this.normalizeDirectIdentityJid(remoteJid) || '', phoneJid || '', ...alternateJids]
          .filter(Boolean)
      )
    );

    return {
      identityJid: phoneJid || this.normalizeDirectIdentityJid(remoteJid) || remoteJid,
      replyJid: remoteJid,
      isGroup: false,
      identityAliases,
    };
  }

  private isLidIdentityJid(value: string): boolean {
    const normalized = this.normalizeDirectIdentityJid(value);
    return Boolean(normalized && (normalized.endsWith('@lid') || normalized.endsWith('@hosted.lid')));
  }

  private isPhoneIdentityJid(value: string): boolean {
    const normalized = this.normalizeDirectIdentityJid(value);
    return Boolean(normalized && (normalized.endsWith('@s.whatsapp.net') || normalized.endsWith('@hosted')));
  }

  private normalizeDirectIdentityJid(value: string): string | null {
    const trimmed = value.trim();
    const at = trimmed.lastIndexOf('@');
    if (at <= 0 || at === trimmed.length - 1) return null;
    const server = trimmed.slice(at + 1).toLowerCase();
    if (!['s.whatsapp.net', 'lid', 'hosted', 'hosted.lid'].includes(server)) return null;
    const userWithDevice = trimmed.slice(0, at);
    const user = userWithDevice.split(':', 1)[0]?.trim() || '';
    if (!user) return null;
    return `${user}@${server}`;
  }

  private async resolveLearnedPhoneJid(lidJid: string): Promise<string | null> {
    const normalizedLid = this.normalizeDirectIdentityJid(lidJid);
    if (!normalizedLid) return null;
    try {
      const repository = (this.sock as unknown as {
        signalRepository?: {
          lidMapping?: {
            getPNForLID?: (jid: string) => Promise<string | null | undefined> | string | null | undefined;
          };
        };
      } | null)?.signalRepository?.lidMapping;
      if (typeof repository?.getPNForLID !== 'function') return null;
      const raw = await this.withTimeout(
        Promise.resolve(repository.getPNForLID(normalizedLid)),
        750,
        'LID-to-PN lookup timed out'
      );
      if (!raw || !this.isPhoneIdentityJid(raw)) return null;
      return this.normalizeDirectIdentityJid(raw);
    } catch {
      // Reverse LID->PN is best-effort and only works when Baileys has already
      // learned the mapping. Missing phone information must never block a reply.
      return null;
    }
  }

  private mediaOnlyLabel(type: WhatsAppMessage['type']): string {
    switch (type) {
      case 'audio':
        return '[Voice message]';
      case 'image':
        return '[Image]';
      case 'video':
        return '[Video]';
      case 'document':
        return '[Document]';
      case 'location':
        return '[Location shared]';
      case 'contact':
        return '[Contact shared]';
      case 'sticker':
        return '[Sticker]';
      default:
        return '[WhatsApp message]';
    }
  }

  private getKeyString(
    msg: proto.IWebMessageInfo,
    field: string
  ): string {
    const key = msg.key as unknown as Record<string, unknown>;
    const message = msg as unknown as Record<string, unknown>;
    const candidates = [key[field], message[field]];
    for (const value of candidates) {
      if (typeof value === 'string' && value.trim()) return value.trim();
    }
    return '';
  }

  private firstPhoneJid(...values: string[]): string | null {
    for (const value of values) {
      const normalized = this.normalizeDirectIdentityJid(value);
      if (normalized && this.isPhoneIdentityJid(normalized)) return normalized;
    }
    return null;
  }

  private unwrapMessage(
    message: proto.IMessage | undefined
  ): proto.IMessage | undefined {
    let current = message;
    const wrappers = [
      'ephemeralMessage',
      'viewOnceMessage',
      'viewOnceMessageV2',
      'viewOnceMessageV2Extension',
      'documentWithCaptionMessage',
      'editedMessage',
    ];

    for (let depth = 0; current && depth < 6; depth += 1) {
      const record = current as unknown as Record<string, unknown>;
      let nested: proto.IMessage | undefined;
      for (const wrapper of wrappers) {
        const container = record[wrapper] as
          | { message?: proto.IMessage | null }
          | undefined;
        if (container?.message) {
          nested = container.message;
          break;
        }
      }
      if (!nested) break;
      current = nested;
    }

    return current;
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

    // Reactions are real user input. In particular, users often react with 👍
    // to accept terms instead of sending a separate "yes" message. Treat the
    // reaction emoji as text so the normal funnel parser can handle it.
    const dynamic = message as unknown as Record<string, unknown>;
    const reaction = dynamic['reactionMessage'] as
      | { text?: string | null }
      | undefined;
    if (reaction?.text) return reaction.text;

    // Newer WhatsApp interactive/native-flow replies are not represented by the
    // older button/list fields above. Read their visible body first, then a
    // conservative set of common JSON fields. This keeps quick-reply UX from
    // silently disappearing when WhatsApp changes the envelope type.
    const interactive = dynamic['interactiveResponseMessage'] as
      | {
          body?: { text?: string | null } | null;
          nativeFlowResponseMessage?: { paramsJson?: string | null } | null;
        }
      | undefined;
    if (interactive?.body?.text) return interactive.body.text;
    const paramsJson = interactive?.nativeFlowResponseMessage?.paramsJson;
    if (paramsJson) {
      try {
        const parsed = JSON.parse(paramsJson) as Record<string, unknown>;
        for (const key of ['title', 'display_text', 'selectedDisplayText', 'id']) {
          const candidate = parsed[key];
          if (typeof candidate === 'string' && candidate.trim()) {
            return candidate.trim();
          }
        }
      } catch {
        // Ignore malformed provider metadata; unsupported content receives the
        // normal fallback below rather than crashing message ingestion.
      }
    }
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
      message.templateButtonReplyMessage ||
      (message as unknown as Record<string, unknown>)['reactionMessage'] ||
      (message as unknown as Record<string, unknown>)['interactiveResponseMessage']
    )
      return 'text';
    if (message.imageMessage) return 'image';
    if (message.videoMessage) return 'video';
    if (message.audioMessage) return 'audio';
    if (message.documentMessage) return 'document';
    if (message.locationMessage) return 'location';
    if (message.contactMessage || message.contactsArrayMessage) return 'contact';
    if (message.stickerMessage) return 'sticker';
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
    return (
      remoteJid.endsWith('@s.whatsapp.net') ||
      remoteJid.endsWith('@lid') ||
      remoteJid.endsWith('@hosted') ||
      remoteJid.endsWith('@hosted.lid') ||
      remoteJid.endsWith('@g.us')
    );
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
