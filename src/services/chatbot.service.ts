import { WhatsAppService } from './whatsapp.service';
import { AIService } from './ai.service';
import { ChatHistoryService } from './chat-history.service';
import { WebSocketService } from './websocket.service';
import { GoogleSheetsService } from './google-sheets.service';
import { LeadCaptureService } from './lead-capture.service';
import { PersistenceService } from './persistence.service';
import { AccessControlService } from './access-control.service';
import {
  WhatsAppMessage,
  MessageProcessingResult,
  ConnectionStatus,
  BotRole,
} from '../types';
import { logger } from '../utils/logger';

const ROLES_PERSISTENCE_NAMESPACE = 'chatRoles';

/**
 * Main Chatbot Service that orchestrates all components
 */
export class ChatbotService {
  private whatsappService: WhatsAppService;
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

  constructor(
    whatsappService: WhatsAppService,
    aiService: AIService,
    chatHistoryService: ChatHistoryService,
    webSocketService: WebSocketService,
    responseDelay: number = 1000,
    googleSheetsService: GoogleSheetsService | null = null,
    leadCaptureService: LeadCaptureService | null = null,
    persistence: PersistenceService | null = null,
    accessControl: AccessControlService | null = null
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

    this.hydrateRoles();
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
  }

  /**
   * Initialize the chatbot
   */
  async initialize(): Promise<void> {
    try {
      logger.info('Initializing chatbot...');

      // Initialize WebSocket service
      this.webSocketService.initialize();

      // Initialize WhatsApp service
      await this.whatsappService.initialize();

      // Initialize optional Google Sheets integration
      if (this.googleSheetsService) {
        await this.googleSheetsService.initialize();
      }

      // Test AI service connection
      const aiConnected = await this.aiService.testConnection();
      if (!aiConnected) {
        throw new Error('AI service connection failed');
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
   * Queue incoming messages by chat, allowing multiple chats in parallel
   */
  private enqueueMessageProcessing(message: WhatsAppMessage): void {
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
        content: incomingMessage.content.substring(0, 50),
      });

      // Notify WebSocket clients
      this.webSocketService.sendMessageReceived(incomingMessage);

      // Add message to chat history
      this.chatHistoryService.addMessage(chatId, incomingMessage);

      // Detect and apply role switch requests from user messages
      const role = this.resolveChatRole(chatId, incomingMessage.content);

      // Capture lead data and build scenario context before AI response.
      const leadContext = this.captureSalesLeadData(chatId, incomingMessage, role);

      // Process message and generate response
      logger.info('About to process message with AI service');
      const result = await this.processMessage(
        incomingMessage,
        chatId,
        role,
        leadContext
      );
      logger.info('AI processing result', {
        success: result.success,
        hasResponse: !!result.response,
        error: result.error,
      });

      if (result.success && result.response) {
        // Add delay to simulate human-like response
        await this.delay(this.responseDelay);

        // Send response via WhatsApp
        const replyTarget = this.getReplyTarget(incomingMessage);
        logger.info('Sending AI response via WhatsApp');
        const sent = await this.whatsappService.sendMessage(
          replyTarget,
          result.response
        );

        if (sent) {
          // Add bot response to chat history
          const botMessage: WhatsAppMessage = {
            id: `bot-${Date.now()}`,
            from: 'bot',
            to: replyTarget,
            timestamp: Date.now(),
            type: 'text',
            content: result.response,
            isGroup: incomingMessage.isGroup,
            groupId: incomingMessage.groupId || undefined,
            senderName: 'AI Assistant',
            isFromBot: true,
          };

          this.chatHistoryService.addMessage(chatId, botMessage);
          this.webSocketService.sendMessageSent(botMessage);

          logger.info('Response sent successfully', {
            to: replyTarget,
            role,
            responseLength: result.response.length,
          });
        } else {
          logger.error('Failed to send WhatsApp response');
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
    if (message.isGroup) {
      return message.groupId || message.to;
    }

    return message.from;
  }

  /**
   * Resolve active role for a chat and apply message-based switches
   */
  private resolveChatRole(chatId: string, messageContent: string): BotRole {
    const requestedRole = this.detectRequestedRole(messageContent);
    const currentRole = this.chatRoles.get(chatId) || this.defaultRole;

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
  private captureSalesLeadData(
    chatId: string,
    message: WhatsAppMessage,
    role: BotRole
  ): string | undefined {
    if (role !== 'sales' || !this.leadCaptureService) {
      return undefined;
    }

    try {
      const update = this.leadCaptureService.updateFromMessage(chatId, message);
      const leadContext =
        this.leadCaptureService.getConversationContext(chatId) ?? undefined;

      if (
        update.shouldPersist &&
        update.record &&
        this.googleSheetsService
      ) {
        void this.googleSheetsService
          .appendLeadRecord(update.record)
          .then(persisted => {
            if (persisted) {
              logger.info('Sales lead data synced to Google Sheets', {
                chatId,
                status: update.record?.status,
                escalationReason: update.record?.escalationReason,
                fieldsUpdated: update.record?.fieldsUpdated,
              });
            }
          })
          .catch(error => {
            logger.error('Failed to capture sales lead data', {
              chatId,
              error: error instanceof Error ? error.message : 'Unknown error',
            });
          });
      }

      return leadContext;
    } catch (error) {
      logger.error('Failed to capture sales lead data', {
        chatId,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      return undefined;
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
  } {
    return {
      whatsappConnected: this.whatsappService.isConnected(),
      aiServiceConnected: this.aiService.validateConfig(),
      webSocketClients: this.webSocketService.getConnectedClientsCount(),
      isProcessing: this.isProcessing,
      totalChats: this.chatHistoryService.getTotalChats(),
      totalMessages: this.chatHistoryService.getTotalMessages(),
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
