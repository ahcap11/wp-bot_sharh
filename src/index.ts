import {
  getAppConfig,
  getAIServiceConfig,
  getGoogleSheetsConfig,
  getNeonSearchConfig,
  getPersistenceConfig,
  getAccessControlConfig,
  getMessagingConfig,
  getSharhApiConfig,
  getSalesPlaybookVersion,
  getConversationSafetyConfig,
} from './config';
import { createMessagingTransport } from './services/messaging-transport.factory';
import { AIService } from './services/ai.service';
import { ChatHistoryService } from './services/chat-history.service';
import { WebSocketService } from './services/websocket.service';
import { ChatbotService } from './services/chatbot.service';
import { GoogleSheetsService } from './services/google-sheets.service';
import { LeadCaptureService } from './services/lead-capture.service';
import { NeonReadService } from './services/neon-read.service';
import { HealthService } from './services/health.service';
import { PersistenceService } from './services/persistence.service';
import { AccessControlService } from './services/access-control.service';
import { SharhApiService } from './services/sharh-api.service';
import { ListingSearchService } from './services/listing-search.service';
import { SharhSyncService } from './services/sharh-sync.service';
import { MessageDeliveryService } from './services/message-delivery.service';
import { SalesPlaybookService } from './services/sales-playbook.service';
import { FunnelQualityService } from './services/funnel-quality.service';
import { ConversationSafetyService } from './services/conversation-safety.service';
import { logger } from './utils/logger';

/**
 * Main application class
 */
class WhatsAppAIChatbot {
  private chatbotService: ChatbotService | null = null;
  private healthService: HealthService | null = null;
  private persistenceService: PersistenceService | null = null;
  private webSocketPort: number = 3001;
  private initRetryTimer: NodeJS.Timeout | null = null;

  constructor() {
    logger.info('WhatsApp AI Chatbot starting...');
  }

  /**
   * Initialize the application
   */
  async initialize(): Promise<void> {
    try {
      // Load configuration
      const appConfig = getAppConfig();
      const aiConfig = getAIServiceConfig();
      const googleSheetsConfig = getGoogleSheetsConfig();
      const neonSearchConfig = getNeonSearchConfig();
      const persistenceConfig = getPersistenceConfig();
      const accessControlConfig = getAccessControlConfig();
      const sharhApiConfig = getSharhApiConfig();
      const messagingConfig = getMessagingConfig();
      const salesPlaybookVersion = getSalesPlaybookVersion();
      const conversationSafetyConfig = getConversationSafetyConfig();
      // Railway health checks use the injected PORT. The currently active
      // production deployment is known to work on 8080, so expose liveness on
      // both values when they differ. This removes ambiguity from an existing
      // Railway target-port/service-variable configuration during rollout.
      const healthPorts = Array.from(new Set([appConfig.port, 8080]));

      // Keep the optional monitoring WebSocket away from every HTTP health port.
      const healthPortSet = new Set(healthPorts);
      let requestedWebSocketPort = appConfig.healthPort;
      while (healthPortSet.has(requestedWebSocketPort)) {
        requestedWebSocketPort += 1;
      }
      this.webSocketPort = requestedWebSocketPort;

      // Apply configured log level to the shared logger.
      logger.level = appConfig.logLevel;

      logger.info('Configuration loaded', {
        port: appConfig.port,
        healthPort: appConfig.healthPort,
        webSocketPort: this.webSocketPort,
        railwayPort: process.env['PORT'] || null,
        healthPorts,
        openaiModel: appConfig.openaiModel,
        maxHistoryLength: appConfig.maxHistoryLength,
        logLevel: appConfig.logLevel,
        persistence: persistenceConfig.enabled,
        allowlist: accessControlConfig.allowlistEnabled,
        rateLimit: accessControlConfig.rateLimitEnabled,
        sharhApi: sharhApiConfig.enabled,
        neonFallback: sharhApiConfig.allowNeonFallback,
        salesPlaybookVersion,
        smartAiRouting: conversationSafetyConfig.smartRoutingEnabled,
        maxAiCallsPerConversation: conversationSafetyConfig.maxAiCallsPerConversation,
        maxAiCallsPerNumberPerDay: conversationSafetyConfig.maxAiCallsPerNumberPerDay,
      });

      // Initialize durable state store (loaded before services hydrate from it).
      if (persistenceConfig.enabled) {
        this.persistenceService = new PersistenceService(
          persistenceConfig.filePath
        );
        this.persistenceService.load();
      }

      const accessControlService = new AccessControlService(
        accessControlConfig
      );

      // Initialize services
      const whatsappService = createMessagingTransport(messagingConfig);
      const sharhApiService = new SharhApiService(sharhApiConfig);
      const neonReadService = new NeonReadService(neonSearchConfig);
      const listingSearchService = new ListingSearchService(
        sharhApiService,
        neonReadService,
        sharhApiConfig.allowNeonFallback
      );
      const sharhSyncService = new SharhSyncService(
        sharhApiService,
        this.persistenceService
      );
      const salesPlaybookService = new SalesPlaybookService(salesPlaybookVersion);
      const funnelQualityService = new FunnelQualityService(salesPlaybookService);
      const aiService = new AIService(
        aiConfig,
        listingSearchService,
        salesPlaybookService
      );
      const chatHistoryService = new ChatHistoryService(
        appConfig.maxHistoryLength,
        this.persistenceService
      );
      const webSocketService = new WebSocketService(
        this.webSocketPort,
        appConfig.wsAuthToken
      );
      const googleSheetsService = new GoogleSheetsService(googleSheetsConfig);
      const leadCaptureService = new LeadCaptureService(
        this.persistenceService,
        salesPlaybookService
      );
      const messageDeliveryService = new MessageDeliveryService(
        this.persistenceService
      );
      const conversationSafetyService = new ConversationSafetyService(
        conversationSafetyConfig,
        this.persistenceService
      );

      // Create chatbot service before starting dependency initialization.
      this.chatbotService = new ChatbotService(
        whatsappService,
        aiService,
        chatHistoryService,
        webSocketService,
        appConfig.responseDelay,
        googleSheetsService,
        leadCaptureService,
        this.persistenceService,
        accessControlService,
        sharhApiService,
        sharhSyncService,
        messageDeliveryService,
        funnelQualityService,
        conversationSafetyService
      );

      // IMPORTANT: expose liveness before any external dependency checks.
      // Railway starts probing /health as soon as the container is deployed.
      // WhatsApp protocol discovery, Google Sheets, SHARH API or OpenAI can
      // legitimately take several seconds (or temporarily be unavailable), but
      // that must not make a healthy Node process fail its deployment healthcheck.
      // /ready remains dependency-aware and can stay 503 until initialization
      // completes, while /health is an immediate process-liveness probe.
      this.healthService = new HealthService(
        healthPorts,
        () => (this.chatbotService ? this.chatbotService.getStatus() : null),
        () => whatsappService.getCurrentQr?.() ?? null,
        whatsappService,
        rawBody => sharhSyncService.enqueueProviderWebhook(rawBody)
      );
      this.healthService.start();

      try {
        await this.chatbotService.initialize();
        logger.info('WhatsApp AI Chatbot initialized successfully! 🚀');
      } catch (error) {
        // Liveness must not disappear because an external dependency had a
        // transient startup failure. Keep the process healthy and retry the
        // chatbot initialization in the background. /ready remains false until
        // the dependencies actually recover.
        logger.error('Chatbot dependency initialization failed; retry scheduled', {
          error: error instanceof Error ? error.message : 'Unknown error',
        });
        this.scheduleChatbotInitializationRetry();
      }

      this.logStartupInfo();
    } catch (error) {
      logger.error('Failed to initialize application', {
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      process.exit(1);
    }
  }


  private scheduleChatbotInitializationRetry(): void {
    if (this.initRetryTimer || !this.chatbotService) return;

    this.initRetryTimer = setTimeout(async () => {
      this.initRetryTimer = null;
      if (!this.chatbotService) return;

      try {
        await this.chatbotService.initialize();
        logger.info('Chatbot dependency initialization recovered');
      } catch (error) {
        logger.error('Chatbot dependency initialization retry failed', {
          error: error instanceof Error ? error.message : 'Unknown error',
        });
        this.scheduleChatbotInitializationRetry();
      }
    }, 15000);
    this.initRetryTimer.unref?.();
  }

  /**
   * Log startup information
   */
  private logStartupInfo(): void {
    if (!this.chatbotService) return;

    const status = this.chatbotService.getStatus();

    console.log('\n' + '='.repeat(60));
    console.log('🤖 WhatsApp AI Chatbot is running!');
    console.log('='.repeat(60));
    console.log(
      '📱 WhatsApp Status:',
      status.whatsappConnected ? '✅ Connected' : '❌ Disconnected'
    );
    console.log(
      '🧠 AI Service:',
      status.aiServiceConnected ? '✅ Connected' : '❌ Disconnected'
    );
    console.log('🌐 WebSocket Clients:', status.webSocketClients);
    console.log('💬 Active Chats:', status.totalChats);
    console.log('📝 Total Messages:', status.totalMessages);
    console.log('='.repeat(60));
    console.log(`🔗 WebSocket Server: ws://localhost:${this.webSocketPort}`);
    if (this.healthService) {
      console.log('❤️  Health Probes:    /health and /ready');
    }
    console.log('📋 Scan the QR code above to connect WhatsApp');
    console.log('⏹️  Press Ctrl+C to stop the bot');
    console.log('='.repeat(60) + '\n');
  }

  /**
   * Start the application
   */
  async start(): Promise<void> {
    await this.initialize();

    // Handle graceful shutdown
    process.on('SIGINT', async () => {
      logger.info('Received SIGINT, shutting down gracefully...');
      await this.shutdown();
      process.exit(0);
    });

    process.on('SIGTERM', async () => {
      logger.info('Received SIGTERM, shutting down gracefully...');
      await this.shutdown();
      process.exit(0);
    });

    // Handle uncaught exceptions
    process.on('uncaughtException', error => {
      logger.error('Uncaught Exception', {
        error: error.message,
        stack: error.stack,
      });
      this.shutdown().finally(() => process.exit(1));
    });

    process.on('unhandledRejection', (reason, promise) => {
      logger.error('Unhandled Rejection', {
        reason: reason instanceof Error ? reason.message : reason,
        promise,
      });
      this.shutdown().finally(() => process.exit(1));
    });
  }

  /**
   * Shutdown the application
   */
  async shutdown(): Promise<void> {
    if (this.initRetryTimer) {
      clearTimeout(this.initRetryTimer);
      this.initRetryTimer = null;
    }
    if (this.healthService) {
      this.healthService.stop();
    }
    if (this.chatbotService) {
      await this.chatbotService.shutdown();
    }
    if (this.persistenceService) {
      await this.persistenceService.flush();
    }
    logger.info('Application shutdown completed');
  }

  /**
   * Get application status
   */
  getStatus() {
    return this.chatbotService?.getStatus() || null;
  }
}

/**
 * Main function
 */
async function main(): Promise<void> {
  const app = new WhatsAppAIChatbot();
  await app.start();
}

// Start the application
if (require.main === module) {
  main().catch(error => {
    logger.error('Application failed to start', {
      error: error instanceof Error ? error.message : 'Unknown error',
    });
    process.exit(1);
  });
}

export { WhatsAppAIChatbot };
