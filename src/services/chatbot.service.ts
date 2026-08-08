import { AIService } from './ai.service';
import { ChatHistoryService } from './chat-history.service';
import { WebSocketService } from './websocket.service';
import { GoogleSheetsService } from './google-sheets.service';
import {
  LeadCaptureService,
  FunnelDirective,
  LeadCaptureRecord,
} from './lead-capture.service';
import { PersistenceService } from './persistence.service';
import { AccessControlService } from './access-control.service';
import { MessageDeliveryService } from './message-delivery.service';
import { SharhApiService } from './sharh-api.service';
import type { BuyerMatchAnalysis, BuyerMatchRelaxation, PublicListingRow } from './sharh-api.service';
import { SharhSyncService } from './sharh-sync.service';
import { FunnelQualityService } from './funnel-quality.service';
import { ConversationSafetyService } from './conversation-safety.service';
import type { SalesMessageInterpretation } from './sales-message-intelligence.types';
import {
  WhatsAppMessage,
  MessageProcessingResult,
  ConnectionStatus,
  BotRole,
  MessagingTransport,
  MessageDeliveryUpdate,
  MessagingSendResult,
} from '../types';
import { logger } from '../utils/logger';
import { SHARH_FEE_TERMS } from '../playbooks/sharh-sales.v1';
import { BuyerCriteriaService, BuyerSearchCriteria } from './buyer-criteria.service';

const ROLES_PERSISTENCE_NAMESPACE = 'chatRoles';
const INBOUND_DEDUP_NAMESPACE = 'processedInboundMessages';
const MAX_INBOUND_DEDUP_IDS = 5000;
const BUYER_MATCHES_NAMESPACE = 'buyerListingMatches';
const BUYER_LISTING_CODES_NAMESPACE = 'buyerListingCodes';
const ADMIN_OUTBOX_SENT_NAMESPACE = 'adminOutboxSent';

interface SalesLeadTurn {
  directive: FunnelDirective;
  leadContext?: string | undefined;
  record?: LeadCaptureRecord | undefined;
  interpretation?: SalesMessageInterpretation | undefined;
  aiAssisted?: boolean | undefined;
}

/**
 * Main Chatbot Service that orchestrates all components
 */
export class ChatbotService {
  private whatsappService: MessagingTransport;
  private aiService: AIService;
  private chatHistoryService: ChatHistoryService;
  private webSocketService: WebSocketService;
  private isProcessing: boolean = false;
  private responseDelay: number;
  private activeMessageCount: number = 0;
  private chatProcessingQueues: Map<string, Promise<void>> = new Map();
  private chatRoles: Map<string, BotRole> = new Map();
  private readonly defaultRole: BotRole = 'sales';
  private googleSheetsService: GoogleSheetsService | null;
  private leadCaptureService: LeadCaptureService | null;
  private persistence: PersistenceService | null;
  private accessControl: AccessControlService | null;
  private readonly ignoreGroups: boolean;
  private readonly roleSwitchEnabled: boolean;
  private readonly sharhApiService: SharhApiService | null;
  private readonly sharhSyncService: SharhSyncService | null;
  private readonly messageDeliveryService: MessageDeliveryService;
  private readonly processedInboundIds: Set<string> = new Set();
  private readonly funnelQualityService: FunnelQualityService | null;
  private readonly conversationSafetyService: ConversationSafetyService | null;
  private readonly buyerMatchFingerprints: Map<string, string> = new Map();
  private readonly buyerListingCodes: Map<string, string[]> = new Map();
  private readonly buyerListingRows: Map<string, PublicListingRow[]> = new Map();
  private readonly adminOutboxSent: Map<string, string> = new Map();
  private readonly pendingConversationResets: Set<string> = new Set();
  private readonly buyerCriteriaService = new BuyerCriteriaService();
  private adminOutboxTimer: ReturnType<typeof setInterval> | null = null;
  private adminOutboxProcessing = false;

  constructor(
    whatsappService: MessagingTransport,
    aiService: AIService,
    chatHistoryService: ChatHistoryService,
    webSocketService: WebSocketService,
    responseDelay: number = 1000,
    googleSheetsService: GoogleSheetsService | null = null,
    leadCaptureService: LeadCaptureService | null = null,
    persistence: PersistenceService | null = null,
    accessControl: AccessControlService | null = null,
    sharhApiService: SharhApiService | null = null,
    sharhSyncService: SharhSyncService | null = null,
    messageDeliveryService: MessageDeliveryService | null = null,
    funnelQualityService: FunnelQualityService | null = null,
    conversationSafetyService: ConversationSafetyService | null = null
  ) {
    this.whatsappService = whatsappService;
    this.aiService = aiService;
    this.chatHistoryService = chatHistoryService;
    this.webSocketService = webSocketService;
    this.responseDelay = responseDelay;
    this.googleSheetsService = googleSheetsService;
    this.leadCaptureService = leadCaptureService;
    this.persistence = persistence;
    this.accessControl = accessControl;
    this.sharhApiService = sharhApiService;
    this.sharhSyncService = sharhSyncService;
    this.messageDeliveryService =
      messageDeliveryService || new MessageDeliveryService(persistence);
    this.funnelQualityService = funnelQualityService;
    this.conversationSafetyService = conversationSafetyService;

    this.ignoreGroups = process.env['IGNORE_GROUPS'] !== 'false';
    this.roleSwitchEnabled = process.env['ROLE_SWITCH_ENABLED'] === 'true';
    this.hydrateRoles();
    this.hydrateInboundDedup();
    this.hydrateBuyerMatches();
    this.hydrateBuyerListingCodes();
    this.hydrateAdminOutboxSent();
    this.setupEventHandlers();
    logger.info('Chatbot Service initialized', {
      persisted: Boolean(persistence),
      restoredRoles: this.chatRoles.size,
    });
  }

  /**
   * Restore per-chat roles from the persistence store, if configured.
   */
  private hydrateRoles(): void {
    if (!this.persistence) {
      return;
    }

    const stored = this.persistence.getNamespace<BotRole>(
      ROLES_PERSISTENCE_NAMESPACE
    );
    for (const [chatId, role] of Object.entries(stored)) {
      if (role === 'support' || role === 'sales') {
        this.chatRoles.set(chatId, role);
      }
    }
  }

  private hydrateInboundDedup(): void {
    if (!this.persistence) return;
    const stored = this.persistence.getNamespace<boolean>(INBOUND_DEDUP_NAMESPACE);
    for (const [messageId, processed] of Object.entries(stored)) {
      if (processed === true) this.processedInboundIds.add(messageId);
    }
    this.trimInboundDedup();
  }

  private hydrateBuyerMatches(): void {
    if (!this.persistence) return;
    const stored = this.persistence.getNamespace<string>(BUYER_MATCHES_NAMESPACE);
    for (const [chatId, fingerprint] of Object.entries(stored)) {
      if (typeof fingerprint === 'string' && fingerprint) {
        this.buyerMatchFingerprints.set(chatId, fingerprint);
      }
    }
  }

  private hydrateBuyerListingCodes(): void {
    if (!this.persistence) return;
    const stored = this.persistence.getNamespace<string[]>(BUYER_LISTING_CODES_NAMESPACE);
    for (const [chatId, codes] of Object.entries(stored)) {
      if (Array.isArray(codes)) {
        const clean = codes.filter(code => /^SH-\d{4,}$/i.test(code)).slice(0, 3);
        if (clean.length) this.buyerListingCodes.set(chatId, clean);
      }
    }
  }


  private hydrateAdminOutboxSent(): void {
    if (!this.persistence) return;
    const stored = this.persistence.getNamespace<string>(ADMIN_OUTBOX_SENT_NAMESPACE);
    for (const [messageId, providerMessageId] of Object.entries(stored)) {
      if (messageId && typeof providerMessageId === 'string') {
        this.adminOutboxSent.set(messageId, providerMessageId);
      }
    }
  }

  /**
   * Setup event handlers for all services
   */
  private setupEventHandlers(): void {
    // WhatsApp message handler
    this.whatsappService.onMessage((message: WhatsAppMessage) => {
      this.enqueueMessageProcessing(message);
    });

    // WhatsApp connection status handler
    this.whatsappService.onConnectionStatusChange(
      (status: ConnectionStatus) => {
        this.webSocketService.sendConnectionStatus(status);
        logger.info('WhatsApp connection status changed', { status });
      }
    );

    this.whatsappService.onDeliveryStatus?.((update: MessageDeliveryUpdate) => {
      const record = this.messageDeliveryService.applyUpdate(update);
      this.sharhSyncService?.enqueueAnalytics(
        'whatsapp_message_delivery_status',
        record?.chatId || update.recipientId || 'unknown',
        {
          provider_message_id: update.providerMessageId,
          status: update.status,
          purpose: record?.purpose || null,
          error_code: update.errorCode || null,
        },
        `${update.providerMessageId}-${update.status}`
      );
    });
  }

  /**
   * Initialize the chatbot
   */
  async initialize(): Promise<void> {
    try {
      logger.info('Initializing chatbot...');

      // The monitoring WebSocket is non-critical. A local port conflict must
      // never prevent WhatsApp, buyer matching, or the HTTP health endpoint
      // from starting.
      try {
        this.webSocketService.initialize();
      } catch (error) {
        logger.error('Monitoring WebSocket failed to initialize; continuing', {
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }

      // Initialize WhatsApp service
      await this.whatsappService.initialize();

      // Initialize optional Google Sheets integration
      if (this.googleSheetsService) {
        await this.googleSheetsService.initialize();
      }

      this.sharhSyncService?.start();
      await this.reconcilePersistedSellerCases();
      if (this.sharhApiService?.isEnabled()) {
        const reachable = await this.sharhApiService.checkHealth();
        if (reachable) {
          logger.info('SHARH API startup check succeeded', {
            pendingSyncOperations:
              this.sharhSyncService?.getPendingCount() || 0,
          });
        } else {
          logger.warn('SHARH API startup check failed; outbox remains active', {
            pendingSyncOperations:
              this.sharhSyncService?.getPendingCount() || 0,
          });
        }
        this.startAdminOutboxPolling();
      }

      // AI enhances ambiguous turns, but quota or provider outages must never
      // prevent deterministic qualification, admin takeover, or listing search.
      const aiConnected = await this.aiService.testConnection();
      if (!aiConnected) {
        logger.warn('AI startup check failed; deterministic fallback remains active');
      }

      logger.info('Chatbot initialized successfully');
    } catch (error) {
      logger.error('Failed to initialize chatbot', {
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      throw error;
    }
  }


  /**
   * Re-read recent local transcripts once at startup and re-sync saved seller
   * snapshots. Parser upgrades repair stale drafts without asking the seller to
   * repeat anything. A single unanswered explicit submit command may also be
   * acknowledged so a case cannot remain visibly stuck after deployment.
   */
  private async reconcilePersistedSellerCases(): Promise<void> {
    // Capture nullable dependencies once. Besides being clearer, this keeps the
    // TypeScript null guard valid inside the loop and during async-safe startup
    // reconciliation.
    const leadCaptureService = this.leadCaptureService;
    const sharhSyncService = this.sharhSyncService;
    const sharhApiService = this.sharhApiService;
    if (!leadCaptureService || !sharhSyncService || !sharhApiService?.isEnabled()) return;

    let queued = 0;
    let repaired = 0;
    let recoveredReplies = 0;
    for (const chatId of this.chatHistoryService.getAllChatIds()) {
      const history = this.chatHistoryService.getChatHistory(chatId);
      if (!history.length) continue;

      if (leadCaptureService.reconcileFromHistory(chatId, history)) {
        repaired += 1;
      }

      const latest = history[history.length - 1];
      const lastInbound = [...history]
        .reverse()
        .find(message => !message.isFromBot && message.from !== 'admin');

      // Narrow recovery for a command that was received but never answered by
      // an older build. This intentionally does not replay arbitrary historic
      // messages. It only handles an explicit seller submission command when
      // that command is still the final message in the local transcript.
      let recoveredResponse: string | undefined;
      if (
        latest &&
        lastInbound &&
        latest.id === lastInbound.id &&
        /\b(?:submit|send|review|отправ|рассмотр|مراجعة|أرسل)\b/iu.test(lastInbound.content)
      ) {
        const control = await sharhApiService.getConversationControl(
          chatId,
          lastInbound.from
        );
        if (
          !control?.found ||
          (control.botEnabled && control.owner === 'bot' && !['paused', 'human', 'closed'].includes(control.controlMode))
        ) {
          const navigation = leadCaptureService.handleNavigationCommand(
            chatId,
            lastInbound.content
          );
          if (navigation.handled && navigation.action === 'review' && navigation.response) {
            recoveredResponse = navigation.response;
          }
        }
      }

      const record = leadCaptureService.getCurrentRecord(chatId);
      if (!record || record.inquiryPurpose !== 'selling') continue;

      const reconcileFingerprint = [
        record.businessType,
        record.businessLocation,
        record.desiredSellingPriceAed,
        record.annualRevenueAed,
        record.clientName,
        record.nextStep,
        record.status,
      ]
        .map(value => String(value || '').trim().toLowerCase())
        .join('|')
        .slice(0, 500);
      sharhSyncService.enqueueLead(
        record,
        `startup-seller-reconcile-v2-${lastInbound?.id || 'saved'}-${reconcileFingerprint}`
      );
      queued += 1;

      if (recoveredResponse && this.whatsappService.isConnected()) {
        const sendResult = await this.sendDetailed(chatId, recoveredResponse);
        if (sendResult.success) {
          const botMessage: WhatsAppMessage = {
            id: sendResult.providerMessageIds[0] || `bot-recovery-${Date.now()}`,
            from: 'bot',
            to: chatId,
            timestamp: Date.now(),
            type: 'text',
            content: recoveredResponse,
            isGroup: false,
            senderName: 'AI Assistant',
            isFromBot: true,
          };
          this.chatHistoryService.addMessage(chatId, botMessage);
          this.messageDeliveryService.recordAccepted(
            botMessage.id,
            chatId,
            recoveredResponse,
            'bot_reply',
            sendResult
          );
          sharhSyncService.enqueueMessage(chatId, 'outbound', botMessage, 'sales');
          sharhSyncService.enqueueAnalytics(
            'conversation_missed_reply_recovered',
            chatId,
            { reason: 'explicit_seller_submit_command' },
            botMessage.id
          );
          const recoveryDirective = leadCaptureService.getDirective(chatId);
          leadCaptureService.confirmDirectiveSent(chatId, recoveryDirective);
          recoveredReplies += 1;
          logger.info('Recovered unanswered seller submission command', {
            chatId,
            inboundMessageId: lastInbound?.id || null,
          });
        } else {
          logger.warn('Could not recover unanswered seller submission command; will leave it for the next user turn', {
            chatId,
            inboundMessageId: lastInbound?.id || null,
            error: sendResult.error || 'unknown send error',
          });
        }
      }
    }

    if (queued > 0) {
      logger.info('Persisted seller cases queued for startup reconciliation', {
        queued,
        repaired,
        recoveredReplies,
      });
    }
  }


  private startAdminOutboxPolling(): void {
    if (this.adminOutboxTimer || !this.sharhApiService?.isEnabled()) return;
    const poll = (): void => {
      void this.processAdminOutbox();
    };
    poll();
    this.adminOutboxTimer = setInterval(poll, 3000);
    this.adminOutboxTimer.unref?.();
  }

  private async processAdminOutbox(): Promise<void> {
    if (this.adminOutboxProcessing || !this.sharhApiService?.isEnabled()) return;
    if (!this.whatsappService.isConnected()) return;
    this.adminOutboxProcessing = true;
    try {
      const items = await this.sharhApiService.fetchAdminOutbox(10);
      for (const item of items) {
        const alreadySentProviderId = this.adminOutboxSent.get(item.id);
        if (alreadySentProviderId !== undefined) {
          const acknowledged = await this.sharhApiService.acknowledgeAdminOutboxMessage(
            item.id,
            'sent',
            alreadySentProviderId || undefined
          );
          if (acknowledged) {
            this.adminOutboxSent.delete(item.id);
            this.persistence?.removeItem(ADMIN_OUTBOX_SENT_NAMESPACE, item.id);
          }
          continue;
        }

        const result = await this.sendDetailed(item.externalChatId, item.content);
        if (result.success) {
          const providerMessageId = result.providerMessageIds[0] || '';
          this.adminOutboxSent.set(item.id, providerMessageId);
          this.persistence?.setItem(ADMIN_OUTBOX_SENT_NAMESPACE, item.id, providerMessageId);
          await this.persistence?.flush();
          const acknowledged = await this.sharhApiService.acknowledgeAdminOutboxMessage(
            item.id,
            'sent',
            providerMessageId || undefined
          );
          if (acknowledged) {
            this.adminOutboxSent.delete(item.id);
            this.persistence?.removeItem(ADMIN_OUTBOX_SENT_NAMESPACE, item.id);
          }
          this.chatHistoryService.addMessage(item.externalChatId, {
            id: providerMessageId || `admin-${item.id}`,
            from: 'admin',
            to: item.externalChatId,
            timestamp: Date.now(),
            type: 'text',
            content: item.content,
            isGroup: false,
            senderName: item.senderName || 'SHARH team',
            isFromBot: false,
          });
          logger.info('Admin WhatsApp reply delivered', {
            conversationId: item.conversationId,
            messageId: item.id,
          });
        } else {
          await this.sharhApiService.acknowledgeAdminOutboxMessage(
            item.id,
            'failed',
            undefined,
            result.error || 'WhatsApp provider rejected the message'
          );
          logger.warn('Admin WhatsApp reply failed', {
            conversationId: item.conversationId,
            messageId: item.id,
            error: result.error || 'unknown send error',
          });
        }
      }
    } catch (error) {
      logger.warn('Admin WhatsApp outbox poll failed', {
        error: error instanceof Error ? error.message : 'unknown error',
      });
    } finally {
      this.adminOutboxProcessing = false;
    }
  }

  /**
   * Queue incoming messages by chat, allowing multiple chats in parallel
   */
  private enqueueMessageProcessing(message: WhatsAppMessage): void {
    const from = message.from || '';
    const isBroadcastOrChannel =
      from.endsWith('@broadcast') ||
      from === 'status@broadcast' ||
      from.endsWith('@newsletter');
    if (isBroadcastOrChannel || (this.ignoreGroups && message.isGroup)) {
      logger.debug('Ignoring non-direct message', {
        from,
        isGroup: message.isGroup,
      });
      return;
    }

    if (message.id && this.processedInboundIds.has(message.id)) {
      logger.debug('Ignoring duplicate inbound provider message', {
        messageId: message.id,
        from,
      });
      return;
    }
    if (this.accessControl) {
      const verdict = this.accessControl.evaluate(message.from);
      if (!verdict.allowed) {
        logger.warn('Inbound message blocked by access control', {
          from: message.from,
          reason: verdict.reason,
        });
        return;
      }
    }

    // Persist provider-message deduplication only after the sender passes access
    // control. A temporarily blocked message must not poison a later retry.
    if (message.id) {
      this.processedInboundIds.add(message.id);
      this.persistence?.setItem(INBOUND_DEDUP_NAMESPACE, message.id, true);
      this.trimInboundDedup();
    }

    const chatId = this.getChatId(message);
    const existingQueue =
      this.chatProcessingQueues.get(chatId) || Promise.resolve();

    const queuedTask = existingQueue
      .catch(error => {
        logger.error('Previous queued message failed', {
          chatId,
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      })
      .then(async () => {
        this.activeMessageCount += 1;
        this.isProcessing = this.activeMessageCount > 0;

        try {
          await this.handleIncomingMessage(message, chatId);
        } finally {
          this.activeMessageCount = Math.max(0, this.activeMessageCount - 1);
          this.isProcessing = this.activeMessageCount > 0;
        }
      });

    this.chatProcessingQueues.set(chatId, queuedTask);

    void queuedTask.finally(() => {
      if (this.chatProcessingQueues.get(chatId) === queuedTask) {
        this.chatProcessingQueues.delete(chatId);
      }
    });
  }

  /**
   * Handle incoming WhatsApp message
   */
  private async handleIncomingMessage(
    message: WhatsAppMessage,
    chatId: string
  ): Promise<void> {
    const incomingMessage: WhatsAppMessage = {
      ...message,
      isFromBot: false,
    };

    const startTime = Date.now();

    try {
      logger.info('Processing incoming message', {
        from: incomingMessage.from,
        chatId,
        length: incomingMessage.content.length,
      });

      // Notify WebSocket clients
      this.webSocketService.sendMessageReceived(incomingMessage);

      // Add message to chat history
      this.chatHistoryService.addMessage(chatId, incomingMessage);

      // Detect and apply role switch requests from user messages
      const role = this.resolveChatRole(chatId, incomingMessage.content);
      this.sharhSyncService?.enqueueMessage(
        chatId,
        'inbound',
        incomingMessage,
        role
      );
      this.sharhSyncService?.enqueueAnalytics(
        'conversation_message_received',
        chatId,
        { role, message_type: incomingMessage.type },
        incomingMessage.id
      );

      // Admin control is authoritative. Incoming messages are still persisted,
      // but only an explicit admin pause, takeover, or close may suppress the bot.
      // Review-queue membership never changes conversation ownership.
      let control = this.sharhApiService?.isEnabled()
        ? await this.sharhApiService.getConversationControl(
            chatId,
            incomingMessage.from
          )
        : null;

      if (
        this.pendingConversationResets.has(chatId) &&
        control?.found &&
        !['paused', 'human', 'closed'].includes(control.controlMode)
      ) {
        const released =
          (await this.sharhApiService?.restartConversationForUser(
            chatId,
            incomingMessage.from
          )) ?? false;
        if (released) {
          this.pendingConversationResets.delete(chatId);
          control = {
            ...control,
            botEnabled: true,
            owner: 'bot',
            controlMode: 'bot',
            reviewRequired: false,
          };
        }
      }

      if (
        control?.found &&
        (!control.botEnabled || control.owner !== 'bot')
      ) {
        logger.info('Bot reply suppressed by SHARH conversation control', {
          chatId,
          owner: control.owner,
          controlMode: control.controlMode,
          reviewRequired: control.reviewRequired,
        });
        this.sharhSyncService?.enqueueAnalytics(
          'conversation_bot_suppressed',
          chatId,
          {
            owner: control.owner,
            control_mode: control.controlMode,
            review_required: control.reviewRequired,
          },
          `${incomingMessage.id}-control`
        );
        return;
      }

      // Capture lead data and resolve the application-owned funnel action.
      const salesTurn = await this.captureSalesLeadData(
        chatId,
        incomingMessage,
        role,
        control?.adminGuidance || [],
        control?.recentHumanMessages || []
      );

      if (salesTurn && !salesTurn.directive.shouldRespond) {
        logger.info('Bot response suppressed by funnel ownership/state', {
          chatId,
          stage: salesTurn.directive.stage,
          owner: salesTurn.directive.owner,
        });
        return;
      }

      // Sales uses a single structured AI decision only when the local router
      // finds genuine ambiguity. The second free-form generation call has been
      // removed so ordinary answers and all fallbacks remain deterministic.
      const directResponse = salesTurn?.directive.directResponse;
      let result: MessageProcessingResult;
      if (role === 'sales') {
        const response =
          directResponse ||
          (await this.buildSalesContinuityFallback(
            chatId,
            incomingMessage.content,
            salesTurn
          ));
        result = {
          success: true,
          response,
          processingTime: Date.now() - startTime,
        };
      } else {
        result = await this.processMessage(
          incomingMessage,
          chatId,
          role,
          salesTurn?.leadContext
        );
      }

      if (directResponse) {
        this.webSocketService.sendAIResponseGenerated({
          message: directResponse,
          confidence: salesTurn?.aiAssisted ? 0.9 : 1,
          context: [],
          timestamp: Date.now(),
          role,
        });
      }

      logger.info('Message processing result', {
        success: result.success,
        hasResponse: !!result.response,
        error: result.error,
        deterministic: !salesTurn?.aiAssisted,
      });

      if (result.success && result.response) {
        let outboundResponse = result.response;
        let directiveDelivered = true;
        if (role === 'sales' && this.funnelQualityService) {
          const quality = this.funnelQualityService.evaluate(
            outboundResponse,
            salesTurn?.record,
            salesTurn?.directive
          );
          this.sharhSyncService?.enqueueAnalytics(
            'sales_response_quality_evaluated',
            chatId,
            {
              passed: quality.passed,
              score: quality.score,
              issues: quality.issues,
              playbook_version: salesTurn?.record?.playbookVersion || null,
            },
            `${incomingMessage.id}-quality`
          );
          if (!quality.passed) {
            logger.error('Sales response blocked by quality guard', {
              chatId,
              issues: quality.issues,
            });
            outboundResponse = this.safeSalesFallback(
              salesTurn?.record?.language || 'en'
            );
            directiveDelivered = false;
          }
        }

        if (role === 'sales') {
          outboundResponse = this.preventUnwantedRepeat(
            chatId,
            incomingMessage.content,
            outboundResponse,
            salesTurn
          );
        }

        // Add delay to simulate human-like response
        await this.delay(this.responseDelay);

        // Send response via WhatsApp
        const replyTarget = this.getReplyTarget(incomingMessage);
        logger.info('Sending AI response via WhatsApp');
        const sendResult = await this.sendDetailed(
          replyTarget,
          outboundResponse
        );

        if (sendResult.success) {
          // Add bot response to chat history
          const botMessage: WhatsAppMessage = {
            id: sendResult.providerMessageIds[0] || `bot-${Date.now()}`,
            from: 'bot',
            to: replyTarget,
            timestamp: Date.now(),
            type: 'text',
            content: outboundResponse,
            isGroup: incomingMessage.isGroup,
            groupId: incomingMessage.groupId || undefined,
            senderName: 'AI Assistant',
            isFromBot: true,
          };

          this.messageDeliveryService.recordAccepted(
            botMessage.id,
            replyTarget,
            outboundResponse,
            'bot_reply',
            sendResult
          );
          this.chatHistoryService.addMessage(chatId, botMessage);
          this.webSocketService.sendMessageSent(botMessage);
          this.sharhSyncService?.enqueueMessage(
            chatId,
            'outbound',
            botMessage,
            role
          );
          this.sharhSyncService?.enqueueAnalytics(
            'conversation_message_sent',
            chatId,
            {
              role,
              deterministic: !salesTurn?.aiAssisted,
              funnel_stage: salesTurn?.directive.stage || null,
            },
            botMessage.id
          );
          if (salesTurn && directiveDelivered) {
            this.leadCaptureService?.confirmDirectiveSent(
              chatId,
              salesTurn.directive
            );
          }

          logger.info('Response sent successfully', {
            to: replyTarget,
            role,
            responseLength: outboundResponse.length,
          });
        } else {
          logger.error('Failed to send WhatsApp response', {
            chatId,
            inboundMessageId: incomingMessage.id,
            replyTarget,
            error: sendResult.error || 'Unknown send failure',
          });
        }
      } else {
        logger.error('Message processing failed', { error: result.error });
        this.webSocketService.sendError({
          message: 'Failed to process message',
          error: result.error,
        });
      }

      const processingTime = Date.now() - startTime;
      logger.info('Message processing completed', { processingTime });
    } catch (error) {
      logger.error('Error processing message', {
        chatId,
        inboundMessageId: incomingMessage.id,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      this.webSocketService.sendError({
        message: 'Error processing message',
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  /**
   * Process message and generate AI response
   */
  private async processMessage(
    message: WhatsAppMessage,
    chatId: string,
    role: BotRole,
    leadContext?: string
  ): Promise<MessageProcessingResult> {
    const startTime = Date.now();

    try {
      logger.info('Starting AI message processing');

      // Get chat history for context
      const chatHistory =
        this.chatHistoryService.getConversationContext(chatId);
      logger.info('Retrieved chat history', {
        historyLength: chatHistory.length,
      });

      // Generate AI response
      logger.info('Calling AI service to generate response');
      const aiResponse = await this.aiService.generateResponse(
        message.content,
        chatHistory,
        role,
        leadContext
      );
      logger.info('AI response generated successfully', {
        responseLength: aiResponse.message.length,
      });

      // Notify WebSocket clients about AI response
      this.webSocketService.sendAIResponseGenerated(aiResponse);

      const processingTime = Date.now() - startTime;

      return {
        success: true,
        response: aiResponse.message,
        processingTime,
      };
    } catch (error) {
      const processingTime = Date.now() - startTime;
      logger.error('Error in processMessage', {
        error: error instanceof Error ? error.message : 'Unknown error',
        stack: error instanceof Error ? error.stack : undefined,
      });

      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        processingTime,
      };
    }
  }

  /**
   * Utility function to add delay
   */
  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Resolve chat id used for history and queueing
   */
  private getChatId(message: WhatsAppMessage): string {
    return message.groupId || message.to;
  }

  /**
   * Resolve destination for outbound replies
   */
  private getReplyTarget(message: WhatsAppMessage): string {
    // For direct chats, `to` is the exact conversation JID received from
    // Baileys. It may be a modern @lid address even when `from` was normalized
    // to the alternate phone-number JID for SHARH identity matching.
    return message.groupId || message.to;
  }

  /**
   * Resolve active role for a chat and apply message-based switches
   */
  private resolveChatRole(chatId: string, messageContent: string): BotRole {
    const currentRole = this.chatRoles.get(chatId) || this.defaultRole;

    // Client-triggered role switching is OFF by default.
    const requestedRole = this.roleSwitchEnabled
      ? this.detectRequestedRole(messageContent)
      : null;

    if (requestedRole && requestedRole !== currentRole) {
      this.chatRoles.set(chatId, requestedRole);
      this.persistRole(chatId, requestedRole);
      logger.info('Chat role switched', {
        chatId,
        fromRole: currentRole,
        toRole: requestedRole,
      });
      return requestedRole;
    }

    if (!this.chatRoles.has(chatId)) {
      this.chatRoles.set(chatId, currentRole);
      this.persistRole(chatId, currentRole);
    }

    return this.chatRoles.get(chatId) || this.defaultRole;
  }

  private persistRole(chatId: string, role: BotRole): void {
    this.persistence?.setItem(ROLES_PERSISTENCE_NAMESPACE, chatId, role);
  }

  /**
   * Detect explicit role-switch intent from a user message
   */
  private detectRequestedRole(messageContent: string): BotRole | null {
    const normalized = messageContent.toLowerCase();

    const commandMatch = normalized.match(
      /(?:^|\s)\/?(?:role|mode)\s*[:=]?\s*(support|sales)(?:\s|$)/
    );
    if (commandMatch?.[1] === 'support' || commandMatch?.[1] === 'sales') {
      return commandMatch[1];
    }

    if (
      /\b(switch|change|set)\s+(to\s+)?sales\b/.test(normalized) ||
      /\b(act|behave)\s+(as|like)\s+(a\s+)?sales\b/.test(normalized) ||
      /\bsales\s+mode\b/.test(normalized)
    ) {
      return 'sales';
    }

    if (
      /\b(switch|change|set)\s+(to\s+)?support\b/.test(normalized) ||
      /\b(act|behave)\s+(as|like)\s+(a\s+)?support\b/.test(normalized) ||
      /\bsupport\s+mode\b/.test(normalized)
    ) {
      return 'support';
    }

    return null;
  }

  /**
   * Persist structured sales lead data to Google Sheets (best effort).
   */
  private async captureSalesLeadData(
    chatId: string,
    message: WhatsAppMessage,
    role: BotRole,
    adminGuidance: string[] = [],
    recentHumanMessages: string[] = []
  ): Promise<SalesLeadTurn | undefined> {
    if (role !== 'sales' || !this.leadCaptureService) {
      return undefined;
    }

    try {
      const currentBefore = this.leadCaptureService.getCurrentRecord(chatId);
      const buyerComparison =
        currentBefore?.inquiryPurpose === 'buying'
          ? this.resolveBuyerComparison(chatId, message.content)
          : null;
      const quickBuyerChoice =
        currentBefore?.inquiryPurpose === 'buying' && !buyerComparison
          ? this.resolveBuyerQuickChoice(chatId, message.content)
          : null;
      const listingSelection =
        currentBefore?.inquiryPurpose === 'buying' && !buyerComparison
          ? quickBuyerChoice || this.resolveBuyerListingSelection(chatId, message.content)
          : null;
      if (listingSelection) {
        message = { ...message, content: listingSelection };
      }

      const navigation = this.leadCaptureService.handleNavigationCommand(
        chatId,
        message.content
      );
      if (navigation.handled) {
        if (navigation.resetAiUsage) {
          this.conversationSafetyService?.resetConversation(chatId);
          this.buyerMatchFingerprints.delete(chatId);
          this.persistence?.removeItem(BUYER_MATCHES_NAMESPACE, chatId);
          this.buyerListingCodes.delete(chatId);
          this.buyerListingRows.delete(chatId);
          this.persistence?.removeItem(BUYER_LISTING_CODES_NAMESPACE, chatId);
        }
        if (navigation.restartConfirmed && this.sharhApiService?.isEnabled()) {
          const released = await this.sharhApiService.restartConversationForUser(
            chatId,
            message.from
          );
          if (released) {
            this.pendingConversationResets.delete(chatId);
          } else {
            this.pendingConversationResets.add(chatId);
            logger.warn('Conversation restart saved locally but SHARH review control release is pending', {
              chatId,
            });
          }
        }
        const record = this.leadCaptureService.getCurrentRecord(chatId) || undefined;
        if (record?.inquiryPurpose) {
          this.sharhSyncService?.enqueueLead(
            record,
            `${message.id}-navigation-${navigation.action || 'unknown'}`
          );
        }
        let navigationResponse = navigation.response;
        if (navigation.action === 'continue' && record?.inquiryPurpose === 'buying') {
          const currentDirective = this.leadCaptureService.getDirective(chatId);
          const listingResponse = await this.buildBuyerListingResponse(
            chatId,
            message.content,
            record,
            { ...currentDirective, directResponse: undefined },
            true
          );
          if (listingResponse) navigationResponse = listingResponse;
        }
        const continuationDirective = navigation.continueFunnel
          ? this.leadCaptureService.getDirective(chatId)
          : null;
        this.sharhSyncService?.enqueueAnalytics(
          `conversation_navigation_${navigation.action || 'unknown'}`,
          chatId,
          { action: navigation.action || 'unknown' },
          `${message.id}-navigation`
        );
        return {
          directive: continuationDirective
            ? {
                ...continuationDirective,
                shouldRespond: true,
                directResponse:
                  navigationResponse ||
                  continuationDirective.directResponse ||
                  this.safeSalesFallback(record?.language || 'en'),
              }
            : {
                stage: record?.funnelStage || 'new',
                owner: 'bot',
                shouldRespond: true,
                directResponse:
                  navigationResponse ||
                  this.safeSalesFallback(record?.language || 'en'),
              },
          ...(record ? { record } : {}),
          aiAssisted: false,
        };
      }

      const language = this.leadCaptureService.getLanguage(chatId);
      const safety = this.conversationSafetyService?.screenMessage(
        chatId,
        message.content,
        language
      );
      if (safety && !safety.allowed) {
        this.sharhSyncService?.enqueueAnalytics(
          'conversation_safety_blocked',
          chatId,
          { reason: safety.reason || 'unknown' },
          `${message.id}-safety`
        );
        const currentRecord = this.leadCaptureService.getCurrentRecord(chatId);
        return {
          directive: {
            stage: currentRecord?.funnelStage || 'new',
            owner: 'bot',
            shouldRespond: true,
            directResponse: safety.response || this.safeSalesFallback(safety.language),
          },
          ...(currentRecord ? { record: currentRecord } : {}),
          aiAssisted: false,
        };
      }

      const expectedField = this.leadCaptureService.getExpectedField(chatId);
      let interpretation: SalesMessageInterpretation | null = null;
      let aiLimitNotice = '';
      const shouldUseAi =
        this.conversationSafetyService?.shouldUseAi(
          message.content,
          expectedField
        ) ?? true;
      if (shouldUseAi) {
        const allowance = this.conversationSafetyService?.reserveAiCall(
          chatId,
          message.from
        );
        if (!allowance || allowance.allowed) {
          interpretation = await this.aiService.interpretSalesMessage({
            message: message.content,
            expectedField,
            language,
            knownFacts: [
              this.leadCaptureService.getKnownFactsBlock(chatId) || '',
              adminGuidance.length
                ? `ADMIN GUIDANCE FOR THIS CONVERSATION (trusted operational feedback; never override official SHARH terms or safety rules):\n${adminGuidance.map(item => `- ${item}`).join('\n')}`
                : '',
              recentHumanMessages.length
                ? `RECENT SHARH TEAM REPLIES (conversation context only; continue naturally and do not repeat them):\n${recentHumanMessages.map(item => `- ${item}`).join('\n')}`
                : '',
            ].filter(Boolean).join('\n\n'),
            recentHistory: this.chatHistoryService
              .getConversationContext(chatId)
              .slice(-6)
              .map(item => `${item.isFromBot ? 'Bot' : 'Client'}: ${item.content}`),
          });
        } else {
          aiLimitNotice = this.conversationSafetyService?.aiLimitResponse(
            language,
            allowance.reason
          ) || '';
          this.sharhSyncService?.enqueueAnalytics(
            'ai_assistance_limited',
            chatId,
            { reason: allowance.reason || 'unknown' },
            `${message.id}-ai-limit`
          );
        }
      }

      const update = this.leadCaptureService.updateFromMessage(
        chatId,
        message,
        interpretation
      );
      let record = update.record || this.leadCaptureService.getCurrentRecord(chatId);
      let directive = this.leadCaptureService.getDirective(chatId);

      if (
        record &&
        this.leadCaptureService.isPriceGuidanceRequest(chatId, message.content)
      ) {
        const valuation = this.sharhApiService?.isEnabled()
          ? await this.sharhApiService.calculateIndicativeValuation(record)
          : null;
        directive = this.leadCaptureService.getPriceGuidanceDirective(
          chatId,
          valuation?.formattedRange
        );
        record = this.leadCaptureService.getCurrentRecord(chatId) || record;
        this.sharhSyncService?.enqueueAnalytics(
          'seller_price_guidance_requested',
          chatId,
          {
            valuation_available: Boolean(valuation),
            valuation_low: valuation?.low || null,
            valuation_mid: valuation?.mid || null,
            valuation_high: valuation?.high || null,
          },
          `${message.id}-price-guidance`
        );
      } else if (record?.inquiryPurpose === 'buying') {
        const comparisonResponse = buyerComparison
          ? await this.buildBuyerComparisonResponse(buyerComparison, record.language)
          : null;
        if (comparisonResponse) {
          directive = { ...directive, directResponse: comparisonResponse };
        } else {
          const listingResponse = await this.buildBuyerListingResponse(
            chatId,
            message.content,
            record,
            directive,
            interpretation?.action === 'show_listings'
          );
          if (listingResponse) {
            directive = { ...directive, directResponse: listingResponse };
          }
        }
      }

      const deterministicAcknowledgement = !shouldUseAi
        ? this.buildDeterministicAcknowledgement(
            expectedField,
            record,
            record?.language || language
          )
        : '';
      if (
        !directive.directResponse ||
        Boolean(interpretation?.reply) ||
        Boolean(deterministicAcknowledgement)
      ) {
        const contextualReply =
          interpretation?.reply ||
          (shouldUseAi
            ? this.buildDeterministicContextualReply(
                message.content,
                record?.language || language,
                expectedField,
                interpretation
              )
            : deterministicAcknowledgement);
        if (contextualReply) {
          directive = {
            ...directive,
            directResponse:
              interpretation?.holdFunnel ||
              this.shouldAvoidRepeatingFunnelPrompt(
                message.content,
                interpretation
              )
                ? contextualReply
                : this.composeContextualReply(
                    contextualReply,
                    directive.directResponse
                  ),
          };
        } else if (aiLimitNotice) {
          directive = {
            ...directive,
            directResponse: this.composeContextualReply(
              aiLimitNotice,
              directive.directResponse
            ),
          };
        }
      }

      this.sharhSyncService?.enqueueAnalytics(
        'sales_message_interpreted',
        chatId,
        {
          classification: interpretation?.classification || 'fallback',
          confidence: interpretation?.confidence || 0,
          question_type: interpretation?.questionType || 'none',
          extracted_fields: interpretation
            ? Object.keys(interpretation.fields)
            : [],
          unknown_fields: interpretation?.unknownFields || [],
        },
        `${message.id}-interpretation`
      );

      const scenario = this.leadCaptureService.getConversationContext(chatId);
      const knownFacts = this.leadCaptureService.getKnownFactsBlock(chatId);
      const backendContext = this.sharhApiService?.isEnabled()
        ? await this.sharhApiService.getConversationContext(
            chatId,
            record?.clientPhone || ''
          )
        : '';
      const leadContext =
        [
          scenario,
          knownFacts,
          interpretation
            ? `CURRENT MESSAGE INTERPRETATION (untrusted until application validation):\nclassification=${interpretation.classification}; question_type=${interpretation.questionType}; reason=${interpretation.reason || 'none'}`
            : '',
          backendContext
            ? `SHARH CANONICAL CONTEXT (server-filtered):\n${backendContext}`
            : '',
        ]
          .filter(Boolean)
          .join('\n\n') || undefined;

      const recordToPersist =
        this.leadCaptureService.getCurrentRecord(chatId) || update.record;
      if (update.shouldPersist && recordToPersist) {
        this.sharhSyncService?.enqueueLead(recordToPersist, message.id);
        if (this.isExplicitAccessRequest(message.content, recordToPersist)) {
          this.sharhSyncService?.enqueueAccessRequest(
            recordToPersist,
            message.id
          );
          this.sharhSyncService?.enqueueAnalytics(
            'access_request_submitted',
            chatId,
            {
              listing_public_code: recordToPersist.specificListingCode,
              purpose: 'buyer_due_diligence',
            },
            message.id
          );
        }
        this.sharhSyncService?.enqueueAnalytics(
          `funnel_${recordToPersist.funnelStage}`,
          chatId,
          {
            status: recordToPersist.status,
            owner: recordToPersist.owner,
            inquiry_purpose: recordToPersist.inquiryPurpose || null,
            completion_percent: recordToPersist.completionPercent,
            fields_updated: recordToPersist.fieldsUpdated,
            listing_public_code: recordToPersist.specificListingCode || null,
            playbook_version: recordToPersist.playbookVersion,
            lead_score: recordToPersist.leadScore,
            lead_grade: recordToPersist.leadGrade,
            lead_temperature: recordToPersist.leadTemperature,
            next_best_action_code: recordToPersist.nextBestActionCode,
            objections_detected: recordToPersist.objectionsDetected,
            risk_flags: recordToPersist.riskFlags,
          },
          message.id
        );
      }
      if (
        update.shouldPersist &&
        recordToPersist &&
        this.googleSheetsService
      ) {
        void this.googleSheetsService
          .appendLeadRecord(recordToPersist)
          .then(persisted => {
            if (persisted) {
              logger.info('Sales lead data synced to Google Sheets', {
                chatId,
                status: recordToPersist.status,
                stage: recordToPersist.funnelStage,
                fieldsUpdated: recordToPersist.fieldsUpdated,
              });
            }
          })
          .catch(error => {
            logger.error('Failed to sync sales lead data', {
              chatId,
              error: error instanceof Error ? error.message : 'Unknown error',
            });
          });
      }

      return {
        directive,
        ...(leadContext ? { leadContext } : {}),
        ...(record ? { record } : {}),
        ...(interpretation ? { interpretation } : {}),
        aiAssisted: Boolean(interpretation),
      };
    } catch (error) {
      logger.error('Failed to process sales funnel state', {
        chatId,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      return undefined;
    }
  }

  private buildDeterministicAcknowledgement(
    expectedField: import('./lead-capture.service').LeadField | undefined,
    record: LeadCaptureRecord | null,
    language: 'en' | 'ru' | 'ar'
  ): string {
    if (!expectedField || !record) return '';
    const updates = new Set(
      (record.fieldsUpdated || '')
        .split(',')
        .map(value => value.trim())
        .filter(Boolean)
    );
    const updateKey = expectedField === 'seller_terms'
      ? 'terms_accepted'
      : expectedField;
    if (!updates.has(updateKey)) return '';

    if (expectedField === 'client_name' && record.clientName) {
      const messages = {
        en: `Thank you, ${record.clientName}.`,
        ru: `Спасибо, ${record.clientName}.`,
        ar: `شكراً، ${record.clientName}.`,
      } as const;
      return messages[language];
    }
    if (expectedField === 'inquiry_purpose') {
      const messages = record.inquiryPurpose === 'buying'
        ? { en: 'Understood — you are looking to buy.', ru: 'Понял — вы хотите купить бизнес.', ar: 'مفهوم — أنت تبحث عن مشروع للشراء.' }
        : { en: 'Understood — you are looking to sell.', ru: 'Понял — вы хотите продать бизнес.', ar: 'مفهوم — أنت ترغب في بيع مشروع.' };
      return messages[language];
    }
    if (expectedField === 'seller_terms' && record.termsAccepted === 'yes') {
      const messages = {
        en: 'Thank you. We can continue.',
        ru: 'Спасибо. Можем продолжить.',
        ar: 'شكراً. يمكننا المتابعة.',
      } as const;
      return messages[language];
    }

    // Do not add a generic acknowledgement on every qualification turn.
    // The next question/search result already shows that the input was understood,
    // and repeated “Understood/Noted/Thank you” makes the conversation feel robotic.
    return '';
  }

  private shouldAvoidRepeatingFunnelPrompt(
    content: string,
    interpretation?: SalesMessageInterpretation | null
  ): boolean {
    if (interpretation?.classification === 'question') return true;
    if (interpretation?.holdFunnel) return true;
    // Side questions should be answered on their own. Re-attaching the same
    // qualification prompt makes the bot sound scripted and repetitive.
    return (
      /\?/u.test(content) ||
      /\b(?:commission|fee|success fee|how much do you charge|confidential|confidentiality|privacy|marketing|how does (?:it|this) work|what happens next|process|steps)\b/iu.test(content) ||
      /(?:комисси|сколько.*(?:берете|стоит)|конфиденц|публич|маркетинг|как.*(?:работает|проходит)|что дальше|процесс)/iu.test(content) ||
      /(?:عمولة|رسوم|سرية|خصوصية|تسويق|كيف.*(?:يعمل|تتم)|ما الخطوة التالية|العملية)/u.test(content)
    );
  }

  private preventUnwantedRepeat(
    chatId: string,
    incomingContent: string,
    candidate: string,
    salesTurn?: SalesLeadTurn
  ): string {
    if (!candidate.trim() || this.isExplicitRepeatRequest(incomingContent)) {
      return candidate;
    }

    const recentBotReplies = this.chatHistoryService
      .getRecentMessages(chatId, 10)
      .filter(message => message.isFromBot)
      .slice(-3)
      .map(message => message.content)
      .filter(Boolean);
    if (!recentBotReplies.length) return candidate;

    const repeated = recentBotReplies.some(previous =>
      this.responsesAreNearDuplicate(previous, candidate)
    );
    if (!repeated) return candidate;

    const record =
      salesTurn?.record || this.leadCaptureService?.getCurrentRecord(chatId) || undefined;
    const buyerCriteriaChanged = Boolean(
      record?.inquiryPurpose === 'buying' &&
      record.fieldsUpdated
        .split(',')
        .map(value => value.trim())
        .some(field => [
          'business_type',
          'buyer_location',
          'buyer_budget_aed',
          'buyer_involvement',
          'buyer_minimum_annual_profit_aed',
          'buyer_minimum_roi_pct',
          'buyer_return_period',
          'buyer_excluded_sectors',
          'buyer_profitable_only',
          'buyer_sector_preference',
          'buyer_location_preference',
        ].includes(field))
    );
    if (buyerCriteriaChanged) {
      // A revised criterion triggers a fresh backend search. Never replace that
      // result with the generic “criteria already saved” anti-repeat message.
      return candidate;
    }
    const language = record?.language || 'en';
    const expectedField = salesTurn?.directive.expectedField;
    const lower = incomingContent.toLowerCase();

    if (/\b(?:commission|fee|success fee|how much do you charge)\b|комисси|сколько.*(?:берете|стоит)|عمولة|رسوم/iu.test(lower)) {
      const messages = {
        en: 'The fee terms are unchanged. Which part would you like clarified?',
        ru: 'Условия комиссии не изменились. Какой именно пункт нужно уточнить?',
        ar: 'شروط الرسوم لم تتغير. ما الجزء الذي تريد توضيحه؟',
      } as const;
      return messages[language];
    }

    const focused = this.compactContinuationForField(expectedField, record);
    if (
      focused &&
      !recentBotReplies.some(previous =>
        this.responsesAreNearDuplicate(previous, focused)
      )
    ) {
      return focused;
    }

    if (record?.inquiryPurpose === 'buying') {
      const messages = {
        en: record.status === 'qualified'
          ? 'Your buyer criteria are already saved. Send only what you want to change, or send an SH-XXXX code.'
          : 'I have the details you already sent. Send only the missing or changed buyer criterion.',
        ru: record.status === 'qualified'
          ? 'Критерии покупателя уже сохранены. Напишите только то, что хотите изменить, или отправьте код SH-XXXX.'
          : 'Уже полученные данные сохранены. Напишите только недостающий или изменённый критерий.',
        ar: record.status === 'qualified'
          ? 'تم حفظ معايير المشتري. أرسل فقط ما تريد تغييره أو أرسل رمز SH-XXXX.'
          : 'تم حفظ المعلومات التي أرسلتها. أرسل فقط المعيار الناقص أو الذي تريد تغييره.',
      } as const;
      return messages[language];
    }

    const fallback = {
      en: 'I already have the previous information. Send only the new detail or change.',
      ru: 'Предыдущая информация уже сохранена. Напишите только новую деталь или изменение.',
      ar: 'المعلومات السابقة محفوظة. أرسل فقط المعلومة الجديدة أو التغيير.',
    } as const;
    return fallback[language];
  }

  private compactContinuationForField(
    field: FunnelDirective['expectedField'],
    record?: LeadCaptureRecord
  ): string {
    if (!field) return '';
    const language = record?.language || 'en';
    const prompts: Record<
      NonNullable<FunnelDirective['expectedField']>,
      Record<'en' | 'ru' | 'ar', string>
    > = {
      inquiry_purpose: {
        en: 'Reply only with “buy” or “sell”.',
        ru: 'Ответьте только «купить» или «продать».',
        ar: 'أجب فقط «شراء» أو «بيع».',
      },
      client_name: {
        en: 'I only need the name you want me to use.',
        ru: 'Мне нужно только имя, которым к вам обращаться.',
        ar: 'أحتاج فقط الاسم الذي تفضّل أن أخاطبك به.',
      },
      seller_terms: {
        en: 'Reply “yes” to proceed, or tell me which term you want clarified.',
        ru: 'Ответьте «да», чтобы продолжить, или укажите, какой пункт нужно уточнить.',
        ar: 'أجب «نعم» للمتابعة أو اذكر البند الذي تريد توضيحه.',
      },
      business_type: {
        en: record?.inquiryPurpose === 'buying'
          ? 'I only still need the sector. A sector name or “any sector” is enough.'
          : 'I only still need what the business does.',
        ru: record?.inquiryPurpose === 'buying'
          ? 'Мне не хватает только сферы. Достаточно названия сферы или «любая сфера».'
          : 'Мне не хватает только информации о том, чем занимается бизнес.',
        ar: record?.inquiryPurpose === 'buying'
          ? 'ينقصني فقط القطاع. يكفي اسم القطاع أو «أي قطاع».'
          : 'ينقصني فقط نشاط المشروع.',
      },
      business_location: {
        en: 'I only still need the emirate or area.',
        ru: 'Мне не хватает только эмирата или района.',
        ar: 'ينقصني فقط اسم الإمارة أو المنطقة.',
      },
      annual_revenue_aed: {
        en: 'Send only the approximate annual revenue, or “unknown”.',
        ru: 'Укажите только примерную годовую выручку или «не знаю».',
        ar: 'أرسل فقط الإيراد السنوي التقريبي أو «غير معروف».',
      },
      lease_details: {
        en: 'Send only the lease/rent detail, or “unknown”.',
        ru: 'Укажите только данные по аренде или «не знаю».',
        ar: 'أرسل فقط تفاصيل الإيجار أو «غير معروف».',
      },
      desired_selling_price_aed: {
        en: 'Send only the expected selling price or range.',
        ru: 'Укажите только ожидаемую цену продажи или диапазон.',
        ar: 'أرسل فقط سعر البيع المتوقع أو النطاق.',
      },
      year_established: {
        en: 'Send only the year established, or “unknown”.',
        ru: 'Укажите только год основания или «не знаю».',
        ar: 'أرسل فقط سنة التأسيس أو «غير معروف».',
      },
      employee_count: {
        en: 'Send only the employee count, or “unknown”.',
        ru: 'Укажите только количество сотрудников или «не знаю».',
        ar: 'أرسل فقط عدد الموظفين أو «غير معروف».',
      },
      monthly_operating_expenses_aed: {
        en: 'Send only the approximate monthly operating expenses, or “unknown”.',
        ru: 'Укажите только примерные ежемесячные расходы или «не знаю».',
        ar: 'أرسل فقط المصاريف التشغيلية الشهرية التقريبية أو «غير معروف».',
      },
      monthly_net_profit_aed: {
        en: 'Send only the approximate monthly net profit, or “unknown”.',
        ru: 'Укажите только примерную ежемесячную чистую прибыль или «не знаю».',
        ar: 'أرسل فقط صافي الربح الشهري التقريبي أو «غير معروف».',
      },
      liabilities: {
        en: 'Send only the liabilities detail, or “none/unknown”.',
        ru: 'Укажите только обязательства или «нет/не знаю».',
        ar: 'أرسل فقط تفاصيل الالتزامات أو «لا يوجد/غير معروف».',
      },
      contracts_licenses: {
        en: 'Send only the key licences/contracts, or “unknown”.',
        ru: 'Укажите только ключевые лицензии/контракты или «не знаю».',
        ar: 'أرسل فقط التراخيص/العقود الرئيسية أو «غير معروف».',
      },
      sale_reason_urgency: {
        en: 'Send only the sale reason or timing.',
        ru: 'Укажите только причину продажи или сроки.',
        ar: 'أرسل فقط سبب البيع أو الإطار الزمني.',
      },
      included_assets: {
        en: 'Send only what is included in the sale.',
        ru: 'Укажите только то, что входит в продажу.',
        ar: 'أرسل فقط ما يشمله البيع.',
      },
      buyer_budget_aed: {
        en: 'I only still need your maximum budget, e.g. “1M AED”.',
        ru: 'Мне не хватает только максимального бюджета, например «1M AED».',
        ar: 'ينقصني فقط الحد الأقصى للميزانية، مثلاً «1M AED».',
      },
      buyer_location: {
        en: 'Send only the preferred emirate/area, or say location is flexible.',
        ru: 'Укажите только желаемый эмират/район или напишите, что локация не важна.',
        ar: 'أرسل فقط الإمارة/المنطقة المفضلة أو اذكر أن الموقع مرن.',
      },
      buyer_timeline: {
        en: 'Send only your preferred acquisition timing.',
        ru: 'Укажите только желаемые сроки покупки.',
        ar: 'أرسل فقط التوقيت المفضل للاستحواذ.',
      },
      buyer_involvement: {
        en: 'Reply only with passive, active, or either.',
        ru: 'Ответьте только: пассивно, активно или оба варианта.',
        ar: 'أجب فقط: سلبي، نشط، أو كلاهما.',
      },
      buyer_funding_status: {
        en: 'Send only the funding method: own funds, financing, or both.',
        ru: 'Укажите только способ финансирования: свои средства, финансирование или оба варианта.',
        ar: 'أرسل فقط طريقة التمويل: أموال خاصة، تمويل، أو كلاهما.',
      },
      buyer_additional_comments: {
        en: 'Send only any additional buyer requirement, or “none”.',
        ru: 'Укажите только дополнительное требование или «нет».',
        ar: 'أرسل فقط أي متطلب إضافي أو «لا يوجد».',
      },
      contact_preference: {
        en: 'Send only the preferred contact name/time.',
        ru: 'Укажите только имя и удобное время для связи.',
        ar: 'أرسل فقط الاسم والوقت المناسب للتواصل.',
      },
    };
    return prompts[field][language];
  }

  private responsesAreNearDuplicate(left: string, right: string): boolean {
    const a = this.normalizeResponseForRepeat(left);
    const b = this.normalizeResponseForRepeat(right);
    if (!a || !b) return false;
    if (a === b) return true;

    const minLength = Math.min(a.length, b.length);
    const maxLength = Math.max(a.length, b.length);
    if (minLength >= 60 && (a.includes(b) || b.includes(a)) && minLength / maxLength >= 0.82) {
      return true;
    }

    if (minLength < 80) return false;
    const aTokens = new Set(a.split(' ').filter(token => token.length > 2));
    const bTokens = new Set(b.split(' ').filter(token => token.length > 2));
    if (!aTokens.size || !bTokens.size) return false;
    let intersection = 0;
    for (const token of aTokens) {
      if (bTokens.has(token)) intersection += 1;
    }
    const union = new Set([...aTokens, ...bTokens]).size;
    return union > 0 && intersection / union >= 0.86;
  }

  private normalizeResponseForRepeat(value: string): string {
    return value
      .toLowerCase()
      .replace(/https?:\/\/\S+/g, '<url>')
      .replace(/[^\p{L}\p{N}%]+/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private isExplicitRepeatRequest(content: string): boolean {
    return /\b(?:show|send|list|repeat)\s+(?:them|it|that|results?|options?)?\s*again\b|\bagain please\b|(?:повтори|покажи|отправь).*(?:ещ[её] раз|снова)|(?:أعد|اعرض|أرسل).*(?:مرة أخرى|مجدداً)/iu.test(content);
  }

  private composeContextualReply(reply: string, next?: string): string {
    const first = reply.trim();
    const second = (next || '').trim();
    if (!second) return first;
    if (!first) return second;
    const normalizedFirst = first.toLowerCase().replace(/\s+/g, ' ');
    const normalizedSecond = second.toLowerCase().replace(/\s+/g, ' ');
    if (normalizedFirst.includes(normalizedSecond) || normalizedSecond.includes(normalizedFirst)) {
      return first.length >= second.length ? first : second;
    }
    const questionCount = (first.match(/\?/g) || []).length;
    return questionCount > 0 ? first : `${first}\n\n${second}`;
  }

  private buildDeterministicContextualReply(
    content: string,
    language: 'en' | 'ru' | 'ar',
    expectedField?: import('./lead-capture.service').LeadField,
    interpretation?: SalesMessageInterpretation | null
  ): string {
    const text = content.toLowerCase();
    const asksForClarification = /what do you mean|can you explain|could you clarify|why do you need|why are you asking|что вы имеете в виду|объясните|зачем вам|почему спрашиваете|ماذا تقصد|وضح|لماذا تحتاج|لماذا تسأل/iu.test(text);

    if (/\b(?:commission|fee|success fee|your fee|how much do you charge)\b|комисси|сколько.*(?:берете|стоит)|عمولة|رسوم/iu.test(text)) {
      return SHARH_FEE_TERMS[language];
    }
    if (/\b(?:confidential|confidentiality|privacy|public|publish|marketing)\b|конфиденц|публич|публиков|маркетинг|سرية|خصوصية|نشر|تسويق/iu.test(text)) {
      const messages = {
        en: 'Sensitive information is not published publicly. Detailed access is handled through SHARH’s confidentiality and access process, and marketing is discussed before work begins. What part would you like clarified?',
        ru: 'Чувствительная информация не публикуется открыто. Детальный доступ предоставляется по процедуре конфиденциальности SHARH, а маркетинг согласуется до начала работы. Что именно уточнить?',
        ar: 'لا تُنشر المعلومات الحساسة للعامة. يتم الوصول التفصيلي وفق إجراءات السرية لدى SHARH، وتتم مناقشة التسويق قبل بدء العمل. ما النقطة التي تريد توضيحها؟',
      } as const;
      return messages[language];
    }
    if (/\b(?:how does (?:it|this) work|what happens next|process|steps|how long)\b|как.*(?:работает|проходит)|что дальше|процесс|срок|كيف.*(?:يعمل|تتم)|ما الخطوة التالية|العملية|المدة/iu.test(text)) {
      const messages = {
        en: 'We first understand the business or buyer criteria, then SHARH reviews the information, confirms the appropriate next steps, and manages access and transaction support. Timing depends on readiness, documents, and buyer fit. Which part of the process concerns you?',
        ru: 'Сначала мы уточняем данные бизнеса или критерии покупателя, затем SHARH проверяет информацию, определяет следующие шаги и организует доступ и сопровождение сделки. Срок зависит от готовности, документов и соответствия покупателя. Какую часть процесса уточнить?',
        ar: 'نبدأ بفهم بيانات المشروع أو معايير المشتري، ثم يراجع SHARH المعلومات ويحدد الخطوات المناسبة ويدير الوصول ودعم الصفقة. تعتمد المدة على الجاهزية والمستندات وملاءمة المشتري. ما الجزء الذي تريد توضيحه؟',
      } as const;
      return messages[language];
    }

    if (asksForClarification) {
      const fieldMessages: Partial<Record<import('./lead-capture.service').LeadField, Record<'en' | 'ru' | 'ar', string>>> = {
        client_name: {
          en: 'I mean the name you would like me to use when speaking with you. Could I have your name, please?',
          ru: 'Я имею в виду имя, которым мне к вам обращаться. Как я могу к вам обращаться?',
          ar: 'أقصد الاسم الذي تفضّل أن أخاطبك به. ما الاسم المناسب؟',
        },
        business_type: {
          en: 'This helps SHARH understand the business and match it with relevant buyer demand. What does the business do?',
          ru: 'Это помогает SHARH понять бизнес и сопоставить его с подходящим спросом покупателей. Чем занимается бизнес?',
          ar: 'يساعد ذلك SHARH على فهم المشروع ومطابقته مع طلب المشترين المناسب. ما نشاط المشروع؟',
        },
        business_location: {
          en: 'Location affects buyer matching, operating context, and transfer considerations. In which emirate and area is the business located?',
          ru: 'Локация влияет на подбор покупателей, операционные условия и передачу бизнеса. В каком эмирате и районе находится бизнес?',
          ar: 'يؤثر الموقع في مطابقة المشترين والظروف التشغيلية ونقل المشروع. في أي إمارة ومنطقة يقع المشروع؟',
        },
        annual_revenue_aed: {
          en: 'Annual revenue helps estimate the size of the business and identify suitable buyers. An approximate figure is acceptable. What was the revenue over the last 12 months?',
          ru: 'Годовая выручка помогает оценить масштаб бизнеса и подобрать подходящих покупателей. Подойдёт приблизительная сумма. Какой была выручка за последние 12 месяцев?',
          ar: 'تساعد الإيرادات السنوية على تقدير حجم المشروع وتحديد المشترين المناسبين. يكفي رقم تقريبي. كم بلغت الإيرادات خلال آخر 12 شهراً؟',
        },
        lease_details: {
          en: 'The lease affects fixed costs and whether the premises can transfer with the business. Is the premises owned or leased, and what is the rent and remaining term if known?',
          ru: 'Аренда влияет на постоянные расходы и возможность передачи помещения вместе с бизнесом. Помещение в собственности или аренде, и каковы аренда и оставшийся срок, если известно?',
          ar: 'يؤثر الإيجار في التكاليف الثابتة وإمكانية نقل الموقع مع المشروع. هل الموقع مملوك أم مستأجر، وما قيمة الإيجار والمدة المتبقية إن كانت معروفة؟',
        },
        desired_selling_price_aed: {
          en: 'This is only to understand your expectation; it does not set a final valuation. You can give a range, ask for an indicative SHARH range, or say it is undecided. What range do you currently have in mind?',
          ru: 'Это нужно только для понимания ваших ожиданий и не является финальной оценкой. Можно указать диапазон, запросить ориентир SHARH или сказать, что цена пока не определена. Какой диапазон вы рассматриваете?',
          ar: 'الغرض هو فهم توقعاتك فقط، وليس تحديد تقييم نهائي. يمكنك ذكر نطاق أو طلب نطاق تقديري من SHARH أو القول إن السعر غير محدد. ما النطاق الذي تفكر فيه حالياً؟',
        },
        monthly_operating_expenses_aed: {
          en: 'Operating expenses help assess the business economics. An approximate monthly amount is enough. What are the average monthly operating expenses?',
          ru: 'Операционные расходы нужны для оценки экономики бизнеса. Достаточно приблизительной суммы в месяц. Каковы средние ежемесячные расходы?',
          ar: 'تساعد المصاريف التشغيلية على تقييم اقتصاديات المشروع. يكفي مبلغ شهري تقريبي. ما متوسط المصاريف التشغيلية الشهرية؟',
        },
        monthly_net_profit_aed: {
          en: 'Net profit helps assess operating performance and valuation. An approximate monthly figure is acceptable. What is the average monthly net profit?',
          ru: 'Чистая прибыль помогает оценить результаты бизнеса и стоимость. Подойдёт приблизительная сумма в месяц. Какова средняя ежемесячная чистая прибыль?',
          ar: 'يساعد صافي الربح على تقييم الأداء والتقدير. يكفي رقم شهري تقريبي. ما متوسط صافي الربح الشهري؟',
        },
        liabilities: {
          en: 'Known debts or obligations are important for transaction review. You can say none, unknown, or briefly describe them. Are there any liabilities?',
          ru: 'Известные долги и обязательства важны для проверки сделки. Можно ответить «нет», «не знаю» или кратко описать их. Есть ли обязательства?',
          ar: 'تُعد الديون أو الالتزامات المعروفة مهمة لمراجعة الصفقة. يمكنك قول لا يوجد أو غير معروف أو وصفها باختصار. هل توجد التزامات؟',
        },
        buyer_budget_aed: {
          en: 'A budget lets SHARH show relevant published opportunities rather than unsuitable listings. A range is enough. What budget have you allocated?',
          ru: 'Бюджет позволяет SHARH показывать подходящие опубликованные предложения, а не нерелевантные листинги. Достаточно диапазона. Какой бюджет вы выделили?',
          ar: 'تساعد الميزانية SHARH على عرض الفرص المنشورة المناسبة بدلاً من الإعلانات غير الملائمة. يكفي نطاق. ما الميزانية المخصصة؟',
        },
        buyer_location: {
          en: 'This helps filter listings by the areas you can realistically consider. Which emirate or area do you prefer?',
          ru: 'Это помогает отфильтровать листинги по реально подходящим районам. Какой эмират или район вы предпочитаете?',
          ar: 'يساعد ذلك على تصفية الإعلانات حسب المناطق التي تناسبك فعلياً. ما الإمارة أو المنطقة المفضلة؟',
        },
      };
      const specific = expectedField ? fieldMessages[expectedField]?.[language] : undefined;
      if (specific) return specific;
      const generic = {
        en: 'I am asking only for information needed to handle your SHARH request. An approximate answer, “unknown”, “back”, or “change my answer” is acceptable. What would you like clarified?',
        ru: 'Я спрашиваю только информацию, необходимую для обработки запроса в SHARH. Можно ответить приблизительно, написать «не знаю», «назад» или «изменить ответ». Что именно уточнить?',
        ar: 'أطلب فقط المعلومات اللازمة لمعالجة طلبك لدى SHARH. يمكنك إعطاء إجابة تقريبية أو قول غير معروف أو الرجوع أو تغيير الإجابة. ما الذي تريد توضيحه؟',
      } as const;
      return generic[language];
    }

    if (
      expectedField === 'seller_terms' &&
      /^(?:no|2|нет|لا)$/iu.test(content.trim())
    ) {
      return language === 'ru'
        ? 'Понял. Что именно вас не устраивает: комиссия, конфиденциальность, возможность маркетинга бизнеса или другой пункт?'
        : language === 'ar'
          ? 'مفهوم. ما النقطة التي لا تناسبك: الرسوم، السرية، إمكانية تسويق المشروع، أم نقطة أخرى؟'
          : 'Understood. What is your main concern: the fee, confidentiality, possible marketing of the business, or something else?';
    }
    if (interpretation?.classification === 'off_topic') {
      return this.safeSalesFallback(language);
    }
    if (interpretation?.classification === 'nonsense') {
      return language === 'ru'
        ? 'Я не смог связать этот ответ с текущим вопросом. Достаточно короткого ответа или «не знаю».'
        : language === 'ar'
          ? 'لم أتمكن من ربط هذه الإجابة بالسؤال الحالي. تكفي إجابة قصيرة أو «غير معروف».'
          : 'I could not connect that answer to the current question. A short answer or “unknown” is enough.';
    }
    if (/\?|почему|зачем|как|что|لماذا|كيف|ماذا/iu.test(content)) {
      const fallback = {
        en: 'I can help with SHARH business buying, selling, valuation, listings, confidentiality, fees, and transaction steps. Please rephrase the SHARH-related point you want clarified.',
        ru: 'Я могу помочь по вопросам покупки и продажи бизнеса через SHARH, оценки, листингов, конфиденциальности, комиссии и этапов сделки. Переформулируйте, пожалуйста, связанный с SHARH вопрос.',
        ar: 'يمكنني المساعدة في شراء وبيع المشاريع عبر SHARH والتقييم والإعلانات والسرية والرسوم وخطوات الصفقة. أعد صياغة النقطة المتعلقة بـ SHARH التي تريد توضيحها.',
      } as const;
      return fallback[language];
    }
    return '';
  }

  private async buildBuyerListingResponse(
    chatId: string,
    message: string,
    record: LeadCaptureRecord,
    directive: FunnelDirective,
    force: boolean = false
  ): Promise<string | null> {
    if (!this.sharhApiService?.isEnabled() || record.inquiryPurpose !== 'buying') {
      return null;
    }

    const explicitRequest = this.isListingRequest(message);
    const showClosest = this.isClosestBuyerRequest(message);
    const changed = new Set(
      record.fieldsUpdated
        .split(',')
        .map(value => value.trim())
        .filter(Boolean)
    );
    const hasSearchCriteria = Boolean(
      record.specificListingCode ||
      record.businessType ||
      record.buyerLocation ||
      record.buyerBudgetAed ||
      record.buyerMinimumAnnualProfitAed ||
      record.buyerMinimumRoiPct ||
      record.buyerInvolvement
    );
    const criteriaChanged = [
      'specific_listing_code',
      'business_type',
      'buyer_location',
      'buyer_budget_aed',
      'buyer_involvement',
      'buyer_additional_comments',
      'buyer_minimum_annual_profit_aed',
      'buyer_minimum_roi_pct',
      'buyer_return_period',
      'buyer_excluded_sectors',
      'buyer_profitable_only',
      'buyer_sector_preference',
      'buyer_location_preference',
    ].some(field => changed.has(field));

    if (!force && !explicitRequest && !criteriaChanged && !showClosest) {
      return null;
    }
    if (!hasSearchCriteria && !explicitRequest && !showClosest) {
      return null;
    }

    const criteria = this.buyerCriteriaService.fromRecord(record);
    const clarification = this.buyerCriteriaService.clarificationMessage(
      criteria,
      record.language
    );
    if (!record.specificListingCode && clarification) {
      return clarification;
    }

    const fingerprint = [
      record.specificListingCode,
      record.businessType.toLowerCase(),
      record.buyerSectorPreference,
      record.buyerLocation.toLowerCase(),
      record.buyerLocationPreference,
      record.buyerBudgetAed.toLowerCase(),
      record.buyerInvolvement.toLowerCase(),
      record.buyerAdditionalComments.toLowerCase(),
      record.buyerMinimumAnnualProfitAed.toLowerCase(),
      record.buyerMinimumRoiPct.toLowerCase(),
      record.buyerReturnPeriod.toLowerCase(),
      record.buyerExcludedSectors.toLowerCase(),
      String(record.buyerProfitableOnly),
    ].join('|');
    if (
      !force &&
      !explicitRequest &&
      !showClosest &&
      this.buyerMatchFingerprints.get(chatId) === fingerprint
    ) {
      return null;
    }

    const hadPreviousSearch = this.buyerMatchFingerprints.has(chatId);
    const isCriteriaRefinement = Boolean(
      hadPreviousSearch &&
      criteriaChanged &&
      !force &&
      !explicitRequest &&
      !record.specificListingCode
    );

    let analysis: BuyerMatchAnalysis | undefined;
    let rows: PublicListingRow[];
    let nearMode = false;
    if (record.specificListingCode) {
      rows = await this.sharhApiService.searchPublicListings(record.specificListingCode);
    } else {
      analysis = await this.sharhApiService.searchBuyerMatchAnalysis(record, 3);
      rows = analysis.items;
      if (showClosest && rows.length === 0 && analysis.nearMatches.length > 0) {
        rows = analysis.nearMatches;
        nearMode = true;
      }
    }

    this.buyerMatchFingerprints.set(chatId, fingerprint);
    this.persistence?.setItem(BUYER_MATCHES_NAMESPACE, chatId, fingerprint);

    const nextPrompt = directive.directResponse?.trim() || '';
    const response = this.formatBuyerListingResults(
      chatId,
      record,
      criteria,
      rows,
      isCriteriaRefinement ? changed : undefined,
      analysis,
      nearMode
    );
    const appendNextPrompt = Boolean(
      nextPrompt &&
      !/open a result|replying with its number|refine the search|открыть вариант|أرسل رقمه/i.test(nextPrompt)
    );
    return [response, appendNextPrompt ? nextPrompt : ''].filter(Boolean).join('\n\n');
  }

  private formatBuyerListingResults(
    chatId: string,
    record: LeadCaptureRecord,
    criteria: BuyerSearchCriteria,
    rows: PublicListingRow[],
    refinementFields?: Set<string>,
    analysis?: BuyerMatchAnalysis,
    nearMode: boolean = false
  ): string {
    const language = record.language;
    if (rows.length === 0) {
      if (record.specificListingCode) {
        return language === 'ru'
          ? `Листинг ${record.specificListingCode} сейчас недоступен среди опубликованных предложений. Запрос сохранён.`
          : language === 'ar'
            ? `الإعلان ${record.specificListingCode} غير متاح حالياً ضمن الفرص المنشورة. تم حفظ الطلب.`
            : `Listing ${record.specificListingCode} is not currently available among published opportunities. The request is saved.`;
      }

      const refinementSummary = refinementFields
        ? this.buyerCriteriaRefinementSummary(record, criteria, refinementFields)
        : '';
      const relaxation = analysis?.relaxations[0];
      const relaxationLine = relaxation
        ? this.formatBuyerRelaxation(relaxation, language)
        : '';
      const sanityLine = this.buyerCriteriaSanityNote(criteria, language);
      const closest = analysis?.nearMatches[0];
      const closestCode = closest ? String(closest['public_code'] || '').trim().toUpperCase() : '';
      const closestTitle = closest ? String(closest['title'] || '').trim() : '';
      const hardGaps = closest && Array.isArray(closest['hard_gap_labels'])
        ? closest['hard_gap_labels']
            .map(value => this.localizeBuyerMatchLabel(String(value), language))
            .filter(Boolean)
            .slice(0, 2)
        : [];
      const closestLine = closestCode
        ? language === 'ru'
          ? `Ближайший вариант: ${closestCode}${closestTitle ? ` — ${closestTitle}` : ''}${hardGaps.length ? `. Не проходит по: ${hardGaps.join(', ')}` : ''}. Напишите «показать ближайшие», если хотите увидеть такие варианты.`
          : language === 'ar'
            ? `أقرب خيار: ${closestCode}${closestTitle ? ` — ${closestTitle}` : ''}${hardGaps.length ? `. لا يطابق: ${hardGaps.join('، ')}` : ''}. اكتب «اعرض الأقرب» لرؤية هذه الخيارات.`
            : `Closest available: ${closestCode}${closestTitle ? ` — ${closestTitle}` : ''}${hardGaps.length ? `. It misses: ${hardGaps.join(', ')}` : ''}. Send “show closest” to see these options.`
        : '';

      if (refinementSummary) {
        const noMatch = language === 'ru'
          ? 'Точного совпадения по обновлённым обязательным критериям пока нет.'
          : language === 'ar'
            ? 'لا توجد مطابقة دقيقة لجميع الشروط الإلزامية بعد التعديل.'
            : 'There is still no exact published match for all revised hard criteria.';
        return [refinementSummary, noMatch, sanityLine, relaxationLine, closestLine]
          .filter(Boolean)
          .join('\n');
      }

      const summary = this.buyerCriteriaService.compactSummary(criteria, language);
      const rendered = summary.map(item => `• ${item}`).join('\n');
      const intro = language === 'ru'
        ? 'Точного опубликованного совпадения по всем обязательным критериям сейчас нет.'
        : language === 'ar'
          ? 'لا توجد حالياً مطابقة منشورة دقيقة لجميع الشروط الإلزامية.'
          : 'There is currently no exact published match meeting every hard criterion.';
      const safeguard = language === 'ru'
        ? 'Случайные варианты или листинги с неизвестными обязательными финансовыми данными подставляться не будут.'
        : language === 'ar'
          ? 'لن أستبدلها بخيارات عشوائية أو بإعلانات تفتقد البيانات المالية الإلزامية.'
          : 'I will not substitute random listings or treat missing required financial data as a match.';
      return [intro, rendered, sanityLine, relaxationLine, closestLine, safeguard]
        .filter(Boolean)
        .join('\n');
    }

    const codes = rows
      .map(row => String(row['public_code'] || '').trim().toUpperCase())
      .filter(code => /^SH-\d{4,}$/.test(code))
      .slice(0, 5);
    if (codes.length) {
      this.buyerListingCodes.set(chatId, codes);
      this.buyerListingRows.set(chatId, rows.slice(0, 5));
      this.persistence?.setItem(BUYER_LISTING_CODES_NAMESPACE, chatId, codes);
    }

    const exactCode = Boolean(record.specificListingCode);
    const refinementSummary = refinementFields
      ? this.buyerCriteriaRefinementSummary(record, criteria, refinementFields)
      : '';
    const summary = exactCode || refinementSummary || nearMode
      ? ''
      : this.buyerCriteriaService.compactSummary(criteria, language).join(' · ');
    const header = nearMode
      ? language === 'ru'
        ? 'Ближайшие опубликованные варианты — они не проходят все обязательные условия:'
        : language === 'ar'
          ? 'أقرب الخيارات المنشورة — لكنها لا تحقق جميع الشروط الإلزامية:'
          : 'Closest published options — they do not meet every hard requirement:'
      : exactCode
        ? language === 'ru'
          ? 'Опубликованный листинг:'
          : language === 'ar'
            ? 'الإعلان المنشور:'
            : 'Published listing:'
        : refinementSummary
          ? language === 'ru'
            ? `${refinementSummary}\nПодходящие варианты:`
            : language === 'ar'
              ? `${refinementSummary}\nالخيارات المناسبة:`
              : `${refinementSummary}\nMatching options:`
          : language === 'ru'
            ? `Нашёл ${rows.length} опубликованных варианта${summary ? ` по запросу: ${summary}` : ''}.`
            : language === 'ar'
              ? `وجدت ${rows.length} خيارات منشورة${summary ? ` حسب طلبك: ${summary}` : ''}.`
              : `Found ${rows.length} published option${rows.length === 1 ? '' : 's'}${summary ? ` for: ${summary}` : ''}.`;

    const lines = rows.map((row, index) => {
      const code = String(row['public_code'] || '').trim();
      const title = String(row['title'] || 'Business opportunity').trim();
      const location = String(row['emirate'] || row['region'] || '').trim();
      const sector = String(row['sector'] || '').trim();
      const priceNumber = this.readPositiveNumber(row['parsed_price_aed'] ?? row['price_int']);
      const priceText = priceNumber !== null
        ? `AED ${priceNumber.toLocaleString('en-US')}`
        : String(row['asking'] || row['price'] || '').trim();
      const annualProfit = this.readPositiveNumber(row['annual_profit_aed'] ?? row['ebitda']);
      const roi = this.readPositiveNumber(row['roi_pct']);
      const passive = row['passive_evidence'] === true;
      const profitBasis = String(row['profit_basis'] || '').trim();
      const gaps = Array.isArray(row['match_gaps'])
        ? row['match_gaps']
            .map(value => this.localizeBuyerMatchLabel(String(value), language))
            .filter(Boolean)
        : [];
      const hardGaps = Array.isArray(row['hard_gap_labels'])
        ? row['hard_gap_labels']
            .map(value => this.localizeBuyerMatchLabel(String(value), language))
            .filter(Boolean)
        : [];
      const details = [location, sector, priceText].filter(Boolean).join(' · ');
      const metrics: string[] = [];
      if (annualProfit !== null) {
        metrics.push(
          language === 'ru'
            ? `прибыль AED ${annualProfit.toLocaleString('en-US')}/год`
            : language === 'ar'
              ? `ربح ${annualProfit.toLocaleString('en-US')} درهم/سنة`
              : `profit AED ${annualProfit.toLocaleString('en-US')}/yr`
        );
      }
      if (roi !== null) metrics.push(`ROI ${roi.toLocaleString('en-US')}%`);
      if (passive) {
        metrics.push(
          language === 'ru'
            ? 'управляемый формат указан'
            : language === 'ar'
              ? 'تشغيل مُدار مذكور'
              : 'manager-run indicated'
        );
      }
      const warning = this.buyerListingFinancialNote(priceNumber, annualProfit, roi, profitBasis, language);
      const softGapLine = gaps.length > 0
        ? language === 'ru'
          ? `Не идеально: ${gaps.slice(0, 2).join(', ')}`
          : language === 'ar'
            ? `ليس مثالياً: ${gaps.slice(0, 2).join('، ')}`
            : `Trade-off: ${gaps.slice(0, 2).join(', ')}`
        : '';
      const hardGapLine = nearMode && hardGaps.length > 0
        ? language === 'ru'
          ? `Не проходит по: ${hardGaps.slice(0, 3).join(', ')}`
          : language === 'ar'
            ? `لا يطابق: ${hardGaps.slice(0, 3).join('، ')}`
            : `Misses: ${hardGaps.slice(0, 3).join(', ')}`
        : '';
      const webBase = (process.env['SHARH_WEB_BASE_URL'] || 'https://sharh.ae').replace(/\/$/, '');
      const listingId = String(row['id'] || '').trim();
      const url = listingId ? `${webBase}/listings/${encodeURIComponent(listingId)}` : '';
      return [
        `${index + 1}. ${code ? `${code} — ` : ''}${title}`,
        details ? `   ${details}` : '',
        metrics.length ? `   ${metrics.join(' · ')}` : '',
        warning ? `   ${warning}` : '',
        softGapLine ? `   ${softGapLine}` : '',
        hardGapLine ? `   ${hardGapLine}` : '',
        url ? `   ${url}` : '',
      ].filter(Boolean).join('\n');
    });

    const footer = exactCode
      ? language === 'ru'
        ? 'Финансовые данные взяты из опубликованного листинга и требуют проверки.'
        : language === 'ar'
          ? 'البيانات المالية مأخوذة من الإعلان المنشور وتحتاج إلى التحقق.'
          : 'Financial figures come from the published listing and should be verified.'
      : language === 'ru'
        ? 'Заинтересовал вариант? Отправьте 1, 2 или 3. Можно просто написать «дешевле», «выше прибыль» или что изменить.'
        : language === 'ar'
          ? 'هل أعجبك خيار؟ أرسل 1 أو 2 أو 3. ويمكنك ببساطة قول «الأرخص» أو «أعلى ربح» أو ما تريد تغييره.'
          : 'Interested in one? Send 1, 2 or 3. Or simply say “cheaper”, “higher profit”, or what you want changed.';
    return [header, ...lines, footer].filter(Boolean).join('\n\n');
  }

  private buyerListingFinancialNote(
    price: number | null,
    annualProfit: number | null,
    roi: number | null,
    profitBasis: string,
    language: LeadCaptureRecord['language']
  ): string {
    const unusuallyHigh = Boolean(
      (roi !== null && roi >= 80) ||
      (price !== null && price > 0 && annualProfit !== null && annualProfit >= price)
    );
    if (unusuallyHigh) {
      return language === 'ru'
        ? 'Отчётная доходность необычно высокая — финансовые показатели стоит проверить.'
        : language === 'ar'
          ? 'العائد المعلن مرتفع بشكل غير معتاد — يُنصح بالتحقق من الأرقام المالية.'
          : 'Reported return is unusually high — verify the financial figures.';
    }
    if (/annualised|annualized/i.test(profitBasis)) {
      return language === 'ru'
        ? 'Годовая прибыль рассчитана из указанной месячной прибыли.'
        : language === 'ar'
          ? 'تم احتساب الربح السنوي من الربح الشهري المعلن.'
          : 'Annual profit is calculated from the disclosed monthly figure.';
    }
    return '';
  }

  private buyerCriteriaSanityNote(
    criteria: BuyerSearchCriteria,
    language: LeadCaptureRecord['language']
  ): string {
    if (criteria.maxBudgetAed === null || criteria.minAnnualProfitAed === null) {
      return '';
    }
    if (criteria.maxBudgetAed <= 0 || criteria.minAnnualProfitAed <= 0) return '';

    const impliedPct = (criteria.minAnnualProfitAed / criteria.maxBudgetAed) * 100;
    if (!Number.isFinite(impliedPct) || impliedPct < 75) return '';

    const pct = Math.round(impliedPct);
    return language === 'ru'
      ? `Проверка критериев: минимальная прибыль относительно максимальной цены означает не менее ${pct}% в год. Я сохранил это именно как вы указали, но такой фильтр очень жёсткий.`
      : language === 'ar'
        ? `مراجعة المعايير: الحد الأدنى للربح مقابل الحد الأقصى للسعر يعني ما لا يقل عن ${pct}% سنوياً. أبقيت الشرط كما طلبته، لكنه شديد التقييد.`
        : `Criteria check: minimum profit versus maximum price implies at least ${pct}% per year. I kept it exactly as requested, but that is an unusually restrictive filter.`;
  }

  private formatBuyerRelaxation(
    relaxation: BuyerMatchRelaxation,
    language: LeadCaptureRecord['language']
  ): string {
    const count = relaxation.resultCount;
    const number = typeof relaxation.suggestedValue === 'number'
      ? relaxation.suggestedValue
      : null;
    const resultText = language === 'ru'
      ? `${count} вариант${count === 1 ? '' : count >= 2 && count <= 4 ? 'а' : 'ов'}`
      : language === 'ar'
        ? `${count} خيار`
        : `${count} option${count === 1 ? '' : 's'}`;

    let change = relaxation.label;
    if (relaxation.criterion === 'budget' && number !== null) {
      change = language === 'ru'
        ? `увеличить максимальный бюджет до AED ${number.toLocaleString('en-US')}`
        : language === 'ar'
          ? `رفع الحد الأقصى للميزانية إلى ${number.toLocaleString('en-US')} درهم`
          : `increase maximum budget to AED ${number.toLocaleString('en-US')}`;
    } else if (relaxation.criterion === 'annual_profit' && number !== null) {
      change = language === 'ru'
        ? `снизить минимальную годовую прибыль до AED ${number.toLocaleString('en-US')}`
        : language === 'ar'
          ? `خفض الحد الأدنى للربح السنوي إلى ${number.toLocaleString('en-US')} درهم`
          : `lower minimum annual profit to AED ${number.toLocaleString('en-US')}`;
    } else if (relaxation.criterion === 'roi' && number !== null) {
      change = language === 'ru'
        ? `снизить минимальный ROI до ${number}%`
        : language === 'ar'
          ? `خفض الحد الأدنى للعائد إلى ${number}%`
          : `lower minimum ROI to ${number}%`;
    } else if (relaxation.criterion === 'passive') {
      change = language === 'ru'
        ? 'разрешить активное/операционное участие владельца'
        : language === 'ar'
          ? 'السماح بدور تشغيلي نشط للمالك'
          : 'allow active or owner-operated businesses';
    } else if (relaxation.criterion === 'location') {
      change = language === 'ru'
        ? 'сделать локацию предпочтением, а не обязательным условием'
        : language === 'ar'
          ? 'جعل الموقع تفضيلاً بدلاً من شرط إلزامي'
          : 'treat location as a preference rather than a requirement';
    } else if (relaxation.criterion === 'sector') {
      change = language === 'ru'
        ? 'сделать сферу предпочтением, а не обязательным условием'
        : language === 'ar'
          ? 'جعل القطاع تفضيلاً بدلاً من شرط إلزامي'
          : 'treat sector as a preference rather than a requirement';
    }

    return language === 'ru'
      ? `Минимальное полезное изменение: ${change} → ${resultText}.`
      : language === 'ar'
        ? `أصغر تعديل مفيد: ${change} ← ${resultText}.`
        : `Smallest useful change: ${change} → ${resultText}.`;
  }

  private isClosestBuyerRequest(content: string): boolean {
    return /\b(?:show|see|give|display)?\s*(?:the\s+)?(?:closest|nearest|best available|near matches?|almost matches?)\b|\bshow\s+(?:those|them)\s+anyway\b|(?:покаж(?:и|ите)?\s+(?:ближайш|похож|почти)|ближайшие варианты)|(?:اعرض\s+(?:الأقرب|المشابه)|أقرب الخيارات)/iu.test(content);
  }

  private resolveBuyerComparison(chatId: string, content: string): string[] | null {
    const normalized = content.trim().toLowerCase();
    const hasCompareIntent = /\b(?:compare|comparison|versus|vs\.?|difference|which is better|better one)\b|(?:сравн|против|какой лучше|разниц)|(?:قارن|مقارنة|مقابل|أيهما أفضل)/iu.test(normalized);
    if (!hasCompareIntent) return null;

    const directCodes = Array.from(
      new Set(
        (content.match(/\bSH-\d{1,12}\b/giu) || []).map(code => code.toUpperCase())
      )
    ).slice(0, 3);
    if (directCodes.length >= 2) return directCodes;

    const cached = this.buyerListingCodes.get(chatId) || [];
    if (cached.length < 2) return null;
    const indexes: number[] = [];
    for (const match of normalized.matchAll(/(?:^|[^\d])([1-5])(?=$|[^\d])/g)) {
      const value = Number.parseInt(match[1] || '', 10) - 1;
      if (value >= 0 && value < cached.length && !indexes.includes(value)) indexes.push(value);
    }
    const ordinalMap: Array<[RegExp, number]> = [
      [/\bfirst\b|\b1st\b|перв(?:ый|ую|ого)|الأول/u, 0],
      [/\bsecond\b|\b2nd\b|втор(?:ой|ую|ого)|الثاني/u, 1],
      [/\bthird\b|\b3rd\b|трет(?:ий|ью|ьего)|الثالث/u, 2],
      [/\bfourth\b|\b4th\b|четверт|الرابع/u, 3],
      [/\bfifth\b|\b5th\b|пят|الخامس/u, 4],
    ];
    for (const [pattern, index] of ordinalMap) {
      if (index < cached.length && pattern.test(normalized) && !indexes.includes(index)) indexes.push(index);
    }
    const codes = indexes.slice(0, 3).map(index => cached[index]).filter((code): code is string => Boolean(code));
    return codes.length >= 2 ? codes : null;
  }

  private async buildBuyerComparisonResponse(
    codes: string[],
    language: LeadCaptureRecord['language']
  ): Promise<string | null> {
    if (!this.sharhApiService || codes.length < 2) return null;
    const fetched = await Promise.all(
      codes.slice(0, 3).map(async code => ({
        code,
        row: (await this.sharhApiService!.searchPublicListings(code))[0],
      }))
    );
    const available = fetched.filter(
      (item): item is { code: string; row: PublicListingRow } => Boolean(item.row)
    );
    if (available.length < 2) {
      return language === 'ru'
        ? 'Не удалось загрузить как минимум два из выбранных опубликованных листингов. Выберите другие номера или коды SH-XXXX.'
        : language === 'ar'
          ? 'تعذر تحميل إعلانين منشورين على الأقل من الخيارات المحددة. اختر أرقاماً أو رموز SH-XXXX أخرى.'
          : 'I could not load at least two of the selected published listings. Choose different numbers or SH-XXXX codes.';
    }

    const metrics = available.map(({ code, row }) => {
      const price = this.readPositiveNumber(row['parsed_price_aed'] ?? row['price_int'] ?? row['asking'] ?? row['price']);
      let profit = this.readPositiveNumber(row['annual_profit_aed'] ?? row['ebitda']);
      if (profit === null) {
        const monthly = this.readPositiveNumber(row['monthly_net_profit']);
        if (monthly !== null) profit = monthly * 12;
      }
      const roi = price && profit !== null ? Math.round((profit / price) * 1000) / 10 : null;
      return {
        code,
        title: String(row['title'] || 'Business opportunity').trim(),
        sector: String(row['sector'] || '').trim(),
        location: String(row['emirate'] || row['region'] || '').trim(),
        price,
        profit,
        roi,
      };
    });

    const heading = language === 'ru'
      ? `Сравнение ${metrics.map(item => item.code).join(' vs ')}:`
      : language === 'ar'
        ? `مقارنة ${metrics.map(item => item.code).join(' مقابل ')}:`
        : `Comparison — ${metrics.map(item => item.code).join(' vs ')}:`;
    const lines = metrics.map(item => {
      const price = item.price === null ? '—' : `AED ${item.price.toLocaleString('en-US')}`;
      const profit = item.profit === null ? '—' : `AED ${item.profit.toLocaleString('en-US')}`;
      const roi = item.roi === null ? '—' : `${item.roi}%`;
      return [
        `${item.code} — ${item.title}`,
        [item.location, item.sector].filter(Boolean).join(' · '),
        language === 'ru'
          ? `Цена: ${price} · Годовая прибыль: ${profit} · ROI: ${roi}`
          : language === 'ar'
            ? `السعر: ${price} · الربح السنوي: ${profit} · ROI: ${roi}`
            : `Price: ${price} · Annual profit: ${profit} · ROI: ${roi}`,
      ].filter(Boolean).join('\n');
    });

    const roiKnown = metrics.filter(item => item.roi !== null);
    const priceKnown = metrics.filter(item => item.price !== null);
    const notes: string[] = [];
    if (roiKnown.length >= 2) {
      const best = [...roiKnown].sort((a, b) => (b.roi || 0) - (a.roi || 0))[0];
      if (best) {
        notes.push(
          language === 'ru'
            ? `${best.code} имеет самый высокий раскрытый ROI.`
            : language === 'ar'
              ? `${best.code} لديه أعلى عائد معلن.`
              : `${best.code} has the highest disclosed ROI.`
        );
      }
    }
    if (priceKnown.length >= 2) {
      const cheapest = [...priceKnown].sort((a, b) => (a.price || 0) - (b.price || 0))[0];
      if (cheapest) {
        notes.push(
          language === 'ru'
            ? `${cheapest.code} требует наименьшего раскрытого бюджета.`
            : language === 'ar'
              ? `${cheapest.code} يتطلب أقل ميزانية معلنة.`
              : `${cheapest.code} has the lowest disclosed asking price.`
        );
      }
    }
    const dueDiligence = language === 'ru'
      ? 'Сравнение основано только на опубликованных данных; финансовые показатели требуют due diligence.'
      : language === 'ar'
        ? 'المقارنة مبنية فقط على البيانات المنشورة؛ الأرقام المالية تحتاج إلى فحص نافي للجهالة.'
        : 'This comparison uses published data only; financial figures remain subject to due diligence.';
    return [heading, ...lines, notes.join(' '), dueDiligence].filter(Boolean).join('\n\n');
  }

  private buyerCriteriaRefinementSummary(
    record: LeadCaptureRecord,
    criteria: BuyerSearchCriteria,
    changed: Set<string>
  ): string {
    const language = record.language;
    const updates: string[] = [];

    const money = (value: number | null): string =>
      value === null ? '' : `AED ${value.toLocaleString('en-US')}`;

    if (changed.has('buyer_budget_aed')) {
      const value = criteria.budgetFlexible
        ? language === 'ru'
          ? 'гибкий'
          : language === 'ar'
            ? 'مرنة'
            : 'flexible'
        : money(criteria.maxBudgetAed);
      if (value) {
        updates.push(
          language === 'ru'
            ? `бюджет → ${value}`
            : language === 'ar'
              ? `الميزانية ← ${value}`
              : `budget → ${value}`
        );
      }
    }

    if (changed.has('buyer_minimum_annual_profit_aed') && criteria.minAnnualProfitAed !== null) {
      const value = money(criteria.minAnnualProfitAed);
      updates.push(
        language === 'ru'
          ? `минимальная годовая прибыль → ${value}`
          : language === 'ar'
            ? `الحد الأدنى للربح السنوي ← ${value}`
            : `minimum annual profit → ${value}`
      );
    }

    if (changed.has('buyer_minimum_roi_pct') && criteria.minRoiPct !== null) {
      updates.push(
        language === 'ru'
          ? `минимальный ROI → ${criteria.minRoiPct}%`
          : language === 'ar'
            ? `الحد الأدنى للعائد ← ${criteria.minRoiPct}%`
            : `minimum ROI → ${criteria.minRoiPct}%`
      );
    }

    if (changed.has('buyer_involvement')) {
      const involvement = criteria.passivePreference === 'required'
        ? language === 'ru'
          ? 'только пассивное/управляемое'
          : language === 'ar'
            ? 'تشغيل سلبي/مُدار مطلوب'
            : 'passive/manager-run required'
        : criteria.passivePreference === 'preferred'
          ? language === 'ru'
            ? 'пассивное предпочтительно'
            : language === 'ar'
              ? 'التشغيل السلبي مفضل'
              : 'passive preferred'
          : language === 'ru'
            ? 'активное управление допустимо'
            : language === 'ar'
              ? 'الإدارة النشطة مقبولة'
              : 'active management acceptable';
      updates.push(involvement);
    }

    if (changed.has('business_type') || changed.has('buyer_sector_preference')) {
      const sectorBase = criteria.sector || (language === 'ru' ? 'любая сфера' : language === 'ar' ? 'أي قطاع' : 'any sector');
      const sector = criteria.sector && criteria.sectorPreference === 'required'
        ? `${sectorBase}${language === 'ru' ? ' (обязательно)' : language === 'ar' ? ' (إلزامي)' : ' (required)'}`
        : criteria.sector && criteria.sectorPreference === 'preferred'
          ? `${sectorBase}${language === 'ru' ? ' (предпочтительно)' : language === 'ar' ? ' (مفضل)' : ' (preferred)'}`
          : sectorBase;
      updates.push(
        language === 'ru'
          ? `сфера → ${sector}`
          : language === 'ar'
            ? `القطاع ← ${sector}`
            : `sector → ${sector}`
      );
    }

    if (changed.has('buyer_location') || changed.has('buyer_location_preference')) {
      const locationBase = criteria.emirate || (language === 'ru' ? 'без ограничения' : language === 'ar' ? 'بدون تفضيل' : 'no preference');
      const location = criteria.emirate && criteria.locationPreference === 'required'
        ? `${locationBase}${language === 'ru' ? ' (обязательно)' : language === 'ar' ? ' (إلزامي)' : ' (required)'}`
        : criteria.emirate && criteria.locationPreference === 'preferred'
          ? `${locationBase}${language === 'ru' ? ' (предпочтительно)' : language === 'ar' ? ' (مفضل)' : ' (preferred)'}`
          : locationBase;
      updates.push(
        language === 'ru'
          ? `локация → ${location}`
          : language === 'ar'
            ? `الموقع ← ${location}`
            : `location → ${location}`
      );
    }

    if (changed.has('buyer_excluded_sectors') && criteria.excludedSectors.length > 0) {
      const value = criteria.excludedSectors.join(', ');
      updates.push(
        language === 'ru'
          ? `исключить → ${value}`
          : language === 'ar'
            ? `استبعاد ← ${value}`
            : `exclude → ${value}`
      );
    }

    if (updates.length === 0) return '';
    const joined = updates.slice(0, 3).join('; ');
    return language === 'ru'
      ? `Обновлено: ${joined}.`
      : language === 'ar'
        ? `تم التحديث: ${joined}.`
        : `Updated: ${joined}.`;
  }

  private localizeBuyerMatchLabel(
    value: string,
    language: LeadCaptureRecord['language']
  ): string {
    const key = value.trim().toLowerCase();
    const labels: Record<string, Record<LeadCaptureRecord['language'], string>> = {
      'sector fit': { en: 'sector fit', ru: 'подходящая сфера', ar: 'تطابق القطاع' },
      'location fit': { en: 'location fit', ru: 'подходящая локация', ar: 'تطابق الموقع' },
      'within budget': { en: 'within budget', ru: 'в пределах бюджета', ar: 'ضمن الميزانية' },
      'minimum annual earnings met': {
        en: 'minimum annual profit met',
        ru: 'минимальная годовая прибыль достигнута',
        ar: 'تحقق الحد الأدنى للربح السنوي',
      },
      'positive earnings disclosed': {
        en: 'positive profit disclosed',
        ru: 'раскрыта положительная прибыль',
        ar: 'تم الإفصاح عن ربح إيجابي',
      },
      'minimum roi met': { en: 'minimum ROI met', ru: 'минимальный ROI достигнут', ar: 'تحقق الحد الأدنى للعائد' },
      'managed/passive operation indicated': {
        en: 'manager-run/passive operation indicated',
        ru: 'указано управление без постоянного участия владельца',
        ar: 'تشغيل مُدار يسمح بدور سلبي',
      },
      'passive operation not evidenced': {
        en: 'passive operation is not evidenced',
        ru: 'пассивное управление не подтверждено описанием',
        ar: 'التشغيل السلبي غير مثبت في الوصف',
      },
      'preferred sector not met': {
        en: 'preferred sector not met',
        ru: 'предпочтительная сфера не совпадает',
        ar: 'القطاع المفضل غير متحقق',
      },
      'preferred location not met': {
        en: 'preferred location not met',
        ru: 'предпочтительная локация не совпадает',
        ar: 'الموقع المفضل غير متحقق',
      },
      'required sector not met': {
        en: 'required sector not met',
        ru: 'обязательная сфера не совпадает',
        ar: 'القطاع الإلزامي غير متحقق',
      },
      'required location not met': {
        en: 'required location not met',
        ru: 'обязательная локация не совпадает',
        ar: 'الموقع الإلزامي غير متحقق',
      },
      'above budget': {
        en: 'above budget',
        ru: 'выше бюджета',
        ar: 'أعلى من الميزانية',
      },
      'minimum annual profit not met': {
        en: 'minimum annual profit not met',
        ru: 'ниже минимальной годовой прибыли',
        ar: 'أقل من الحد الأدنى للربح السنوي',
      },
      'minimum roi not met': {
        en: 'minimum ROI not met',
        ru: 'ниже минимального ROI',
        ar: 'أقل من الحد الأدنى للعائد',
      },
      'roi cannot be calculated': {
        en: 'ROI cannot be calculated from disclosed data',
        ru: 'ROI нельзя рассчитать по раскрытым данным',
        ar: 'لا يمكن حساب العائد من البيانات المعلنة',
      },
      'positive earnings not disclosed': {
        en: 'positive profit is not disclosed',
        ru: 'положительная прибыль не раскрыта',
        ar: 'لم يتم الإفصاح عن ربح إيجابي',
      },
      'not profitable': {
        en: 'not profitable on disclosed figures',
        ru: 'по раскрытым данным прибыль отсутствует',
        ar: 'غير مربح وفق الأرقام المعلنة',
      },
      'asking price not disclosed': {
        en: 'asking price is not disclosed',
        ru: 'цена не раскрыта',
        ar: 'سعر البيع غير معلن',
      },
      'earnings not disclosed': {
        en: 'profit is not disclosed',
        ru: 'прибыль не раскрыта',
        ar: 'الربح غير معلن',
      },
    };
    return labels[key]?.[language] || value;
  }

  private readPositiveNumber(value: unknown): number | null {
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
      return Math.round(value * 10) / 10;
    }
    if (typeof value !== 'string') return null;
    const match = value.replace(/,/g, '').match(/-?\d+(?:\.\d+)?/);
    if (!match?.[0]) return null;
    const parsed = Number.parseFloat(match[0]);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
  }

  private resolveBuyerQuickChoice(chatId: string, content: string): string | null {
    const rows = this.buyerListingRows.get(chatId) || [];
    if (!rows.length) return null;
    const normalized = content.trim().toLowerCase();
    const cheapest = /^(?:cheapest|lowest price|lower price|cheaper|budget option|самый деш[её]вый|дешевле|минимальная цена|الأرخص|أقل سعر)$/iu.test(normalized);
    const highestProfit = /^(?:highest profit|more profit|higher profit|most profitable|best profit|выше прибыль|больше прибыли|самая высокая прибыль|أعلى ربح|ربح أعلى)$/iu.test(normalized);
    const highestRoi = /^(?:best roi|highest roi|best return|highest return|лучший roi|выше roi|лучшая доходность|أعلى عائد)$/iu.test(normalized);
    const bestMatch = /^(?:best|best one|best option|best match|strongest match|what would you pick|which one is best|лучший|лучший вариант|какой лучше|أفضل خيار|الأفضل)$/iu.test(normalized);
    const lowerRisk = /^(?:lower risk|lowest risk|safer|safest|more reliable|best verified|strongest data|меньше риск|минимальный риск|над[её]жнее|самый над[её]жный|أقل مخاطرة|الأكثر موثوقية)$/iu.test(normalized);
    if (!cheapest && !highestProfit && !highestRoi && !bestMatch && !lowerRisk) return null;

    const ranked = rows
      .map(row => {
        const code = String(row['public_code'] || '').trim().toUpperCase();
        const price = this.readPositiveNumber(row['parsed_price_aed'] ?? row['price_int'] ?? row['asking'] ?? row['price']);
        const profit = this.readPositiveNumber(row['annual_profit_aed'] ?? row['ebitda']);
        const roi = this.readPositiveNumber(row['roi_pct']);
        const ranking = this.readPositiveNumber(row['ranking_score'] ?? row['match_score']);
        const quality = this.readPositiveNumber(row['listing_quality_score']);
        const warnings = Array.isArray(row['financial_warnings']) ? row['financial_warnings'].length : 0;
        return { code, price, profit, roi, ranking, quality, warnings };
      })
      .filter(item => /^SH-\d{4,}$/.test(item.code));
    if (!ranked.length) return null;

    if (cheapest) {
      return ranked
        .filter(item => item.price !== null)
        .sort((a, b) => (a.price || 0) - (b.price || 0))[0]?.code || null;
    }
    if (highestProfit) {
      return ranked
        .filter(item => item.profit !== null)
        .sort((a, b) => (b.profit || 0) - (a.profit || 0))[0]?.code || null;
    }
    if (highestRoi) {
      return ranked
        .filter(item => item.roi !== null)
        .sort((a, b) => (b.roi || 0) - (a.roi || 0))[0]?.code || null;
    }
    if (lowerRisk) {
      return [...ranked]
        .sort((a, b) => {
          const aScore = (a.quality || 0) - a.warnings * 20;
          const bScore = (b.quality || 0) - b.warnings * 20;
          return bScore - aScore || (b.ranking || 0) - (a.ranking || 0);
        })[0]?.code || null;
    }
    return [...ranked]
      .sort((a, b) => (b.ranking || 0) - (a.ranking || 0) || (b.quality || 0) - (a.quality || 0))[0]?.code || null;
  }

  private resolveBuyerListingSelection(chatId: string, content: string): string | null {
    const cached = this.buyerListingCodes.get(chatId) || [];
    if (!cached.length) return null;
    const normalized = content.trim().toLowerCase();
    if (/\b(?:compare|versus|vs\.?)\b|(?:сравн|قارن)/iu.test(normalized)) return null;

    let index: number | null = null;
    const direct = normalized.match(/^#?\s*([1-5])\s*(?:please|pls)?$/i)?.[1];
    const labelled = normalized.match(/\b(?:option|listing|number|no\.?|result)\s*#?\s*([1-5])\b/i)?.[1];
    const action = normalized.match(/\b(?:open|show|view|tell me (?:more )?about|details? (?:for|on)?)\s+(?:the\s+)?(?:option\s+|listing\s+|result\s+)?#?\s*([1-5])\b/i)?.[1];
    const numeric = direct || labelled || action;
    if (numeric) index = Number.parseInt(numeric, 10) - 1;

    if (index === null) {
      const ordinalMap: Array<[RegExp, number]> = [
        [/\bfirst(?: one)?\b|\b1st\b|перв(?:ый|ую|ого)|الأول/u, 0],
        [/\bsecond(?: one)?\b|\b2nd\b|втор(?:ой|ую|ого)|الثاني/u, 1],
        [/\bthird(?: one)?\b|\b3rd\b|трет(?:ий|ью|ьего)|الثالث/u, 2],
        [/\bfourth(?: one)?\b|\b4th\b|четверт|الرابع/u, 3],
        [/\bfifth(?: one)?\b|\b5th\b|пят|الخامس/u, 4],
      ];
      const selectionIntent = /\b(?:open|show|view|details?|tell me|more about|choose|select|take|interested)\b|(?:покаж|открой|подроб|выбира|интерес)|(?:اعرض|افتح|تفاصيل|اختر|مهتم)/iu.test(normalized);
      for (const [pattern, candidate] of ordinalMap) {
        if (pattern.test(normalized) && (selectionIntent || normalized.split(/\s+/).length <= 3)) {
          index = candidate;
          break;
        }
      }
    }

    return index !== null && index >= 0 && index < cached.length
      ? cached[index] || null
      : null;
  }

  private isListingRequest(content: string): boolean {
    return /(?:\b(?:show|find|see|view|available|current|matching|listings?|businesses|options)\b.*\b(?:buy|listing|business|option)?\b|\bSH-\d{1,12}\b|(?:покаж|найд|листинг|вариант|бизнесы в продаже)|(?:اعرض|ابحث|إعلانات|خيارات|أعمال متاحة))/iu.test(
      content
    );
  }

  private async buildSalesContinuityFallback(
    chatId: string,
    message: string,
    salesTurn?: SalesLeadTurn
  ): Promise<string> {
    const record =
      salesTurn?.record || this.leadCaptureService?.getCurrentRecord(chatId);
    if (record?.inquiryPurpose === 'buying') {
      const currentDirective =
        this.leadCaptureService?.getDirective(chatId) || salesTurn?.directive;
      if (currentDirective) {
        const listingResponse = await this.buildBuyerListingResponse(
          chatId,
          message,
          record,
          currentDirective,
          this.isListingRequest(message)
        );
        if (listingResponse) return listingResponse;
      }
    }

    const nextPrompt = this.leadCaptureService
      ?.getDirective(chatId)
      .directResponse?.trim();
    if (nextPrompt) {
      const prefix = record?.language === 'ru'
        ? 'Ваш прогресс сохранён. Продолжим по имеющейся информации.'
        : record?.language === 'ar'
          ? 'تم حفظ تقدمك. سنواصل باستخدام المعلومات المتاحة.'
          : 'Your progress is saved. I will continue using the available information.';
      return `${prefix}\n\n${nextPrompt}`;
    }

    if (record?.status === 'qualified') {
      if (record.inquiryPurpose === 'selling') {
        return record.language === 'ru'
          ? 'Ваш запрос на продажу сохранён в SHARH. Можно изменить данные, добавить подробности, отправить его на рассмотрение или создать отдельный запрос.'
          : record.language === 'ar'
            ? 'تم حفظ طلب البيع لدى SHARH. يمكنك تحديث المعلومات أو إضافة تفاصيل أو إرساله للمراجعة أو بدء طلب منفصل.'
            : 'Your seller request is saved with SHARH. You can update it, add details, submit it for review, or start a separate request.';
      }
      return record.language === 'ru'
        ? 'Ваш запрос покупателя сохранён в SHARH. Можно уточнить критерии, посмотреть варианты или отправить код SH-XXXX.'
        : record.language === 'ar'
          ? 'تم حفظ طلب الشراء لدى SHARH. يمكنك تعديل المعايير أو عرض الخيارات أو إرسال رمز SH-XXXX.'
          : 'Your buyer request is saved with SHARH. You can refine the criteria, view options, or send an SH-XXXX code.';
    }

    return this.safeSalesFallback(record?.language || 'en');
  }

  private safeSalesFallback(language: 'en' | 'ru' | 'ar'): string {
    const messages = {
      en: 'I can only provide verified SHARH information. The SHARH team can review this point where needed.',
      ru: 'Я могу сообщать только подтверждённую информацию SHARH. При необходимости этот вопрос проверит команда SHARH.',
      ar: 'يمكنني تقديم معلومات SHARH الموثقة فقط، ويمكن لفريق SHARH مراجعة هذه النقطة عند الحاجة.',
    };
    return messages[language];
  }

  private isExplicitAccessRequest(
    content: string,
    record: LeadCaptureRecord
  ): boolean {
    if (
      record.inquiryPurpose !== 'buying' ||
      !record.specificListingCode
    ) {
      return false;
    }

    return /(?:\b(?:nda|data\s*room|dataroom|access|documents?|full\s+financials|confidential\s+(?:details|information))\b|(?:доступ|дата\s*рум|документ|финансов\w*\s+данн|соглашен\w*\s+о\s+неразглаш)|(?:اتفاقية\s+عدم\s+الإفشاء|وصول|غرفة\s+البيانات|مستندات|بيانات\s+مالية))/iu.test(
      content
    );
  }

  private async sendDetailed(
    chatId: string,
    message: string
  ): Promise<MessagingSendResult> {
    if (this.whatsappService.sendMessageDetailed) {
      return this.whatsappService.sendMessageDetailed(chatId, message);
    }
    const success = await this.whatsappService.sendMessage(chatId, message);
    return { success, providerMessageIds: [] };
  }

  private trimInboundDedup(): void {
    while (this.processedInboundIds.size > MAX_INBOUND_DEDUP_IDS) {
      const oldest = this.processedInboundIds.values().next().value as
        | string
        | undefined;
      if (!oldest) break;
      this.processedInboundIds.delete(oldest);
      this.persistence?.removeItem(INBOUND_DEDUP_NAMESPACE, oldest);
    }
  }

  /**
   * Get chatbot status
   */
  getStatus(): {
    whatsappConnected: boolean;
    aiServiceConnected: boolean;
    webSocketClients: number;
    isProcessing: boolean;
    totalChats: number;
    totalMessages: number;
    sharhApiEnabled: boolean;
    sharhApiReachable: boolean | null;
    sharhSyncPending: number;
    deliveryStatuses: Record<string, number>;
  } {
    const sharhStatus = this.sharhApiService?.getRuntimeStatus();
    return {
      whatsappConnected: this.whatsappService.isConnected(),
      aiServiceConnected: this.aiService.validateConfig(),
      webSocketClients: this.webSocketService.getConnectedClientsCount(),
      isProcessing: this.isProcessing,
      totalChats: this.chatHistoryService.getTotalChats(),
      totalMessages: this.chatHistoryService.getTotalMessages(),
      sharhApiEnabled: sharhStatus?.enabled || false,
      sharhApiReachable: sharhStatus?.reachable ?? null,
      sharhSyncPending: this.sharhSyncService?.getPendingCount() || 0,
      deliveryStatuses: this.messageDeliveryService.countByStatus(),
    };
  }

  /**
   * Send manual message (for testing)
   */
  async sendManualMessage(chatId: string, message: string): Promise<boolean> {
    return await this.whatsappService.sendMessage(chatId, message);
  }

  /**
   * Get chat history for a specific chat
   */
  getChatHistory(chatId: string): WhatsAppMessage[] {
    return this.chatHistoryService.getChatHistory(chatId);
  }

  /**
   * Clear chat history
   */
  clearChatHistory(chatId: string): void {
    this.chatHistoryService.clearChatHistory(chatId);
    this.chatRoles.delete(chatId);
    this.persistence?.removeItem(ROLES_PERSISTENCE_NAMESPACE, chatId);
    this.leadCaptureService?.clearLeadState(chatId);
    this.sharhSyncService?.enqueueAnalytics(
      'conversation_cleared',
      chatId,
      {},
      `clear-${Date.now()}`
    );
  }

  /**
   * Search messages in chat history
   */
  searchMessages(chatId: string, query: string): WhatsAppMessage[] {
    return this.chatHistoryService.searchMessages(chatId, query);
  }

  /**
   * Export chat history
   */
  exportChatHistory(chatId: string): string | null {
    return this.chatHistoryService.exportChatHistory(chatId);
  }

  /**
   * Import chat history
   */
  importChatHistory(chatId: string, jsonData: string): boolean {
    return this.chatHistoryService.importChatHistory(chatId, jsonData);
  }

  /**
   * Cleanup old chat histories
   */
  cleanupOldHistories(daysOld: number = 30): number {
    return this.chatHistoryService.cleanupOldHistories(daysOld);
  }

  /**
   * Shutdown chatbot
   */
  async shutdown(): Promise<void> {
    logger.info('Shutting down chatbot...');

    try {
      if (this.adminOutboxTimer) {
        clearInterval(this.adminOutboxTimer);
        this.adminOutboxTimer = null;
      }
      this.sharhSyncService?.stop();
      await this.sharhSyncService?.flush();
      await this.whatsappService.disconnect();
      this.webSocketService.close();
      if (this.persistence) {
        await this.persistence.flush();
      }

      logger.info('Chatbot shutdown completed');
    } catch (error) {
      logger.error('Error during chatbot shutdown', {
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }
}
