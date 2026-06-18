import {
  getAppConfig,
  getAIServiceConfig,
  getGoogleSheetsConfig,
  getNeonSearchConfig,
  getPersistenceConfig,
  getAccessControlConfig,
} from './config';
import { WhatsAppService } from './services/whatsapp.service';
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
import { logger } from './utils/logger';

/**
 * Main application class
 */
class WhatsAppAIChatbot {
  private chatbotService: ChatbotService | null = null;
  private healthService: HealthService | null = null;
  private persistenceService: PersistenceService | null = null;
  private webSocketPort: number = 8080;

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
      this.webSocketPort = appConfig.port;

      // Apply configured log level to the shared logger.
      logger.level = appConfig.logLevel;

      logger.info('Configuration loaded', {
        port: appConfig.port,
        healthPort: appConfig.healthPort,
        openaiModel: appConfig.openaiModel,
        maxHistoryLength: appConfig.maxHistoryLength,
        logLevel: appConfig.logLevel,
        persistence: persistenceConfig.enabled,
        allowlist: accessControlConfig.allowlistEnabled,
        rateLimit: accessControlConfig.rateLimitEnabled,
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
      const whatsappService = new WhatsAppService();
      const neonReadService = new NeonReadService(neonSearchConfig);
      const aiService = new AIService(aiConfig, neonReadService);
      const chatHistoryService = new ChatHistoryService(
        appConfig.maxHistoryLength,
        this.persistenceService
      );
      const webSocketService = new WebSocketService(
        appConfig.port,
        appConfig.wsAuthToken
      );
      const googleSheetsService = new GoogleSheetsService(googleSheetsConfig);
      const leadCaptureService = new LeadCaptureService(
        this.persistenceService
      );

      // Create and initialize chatbot service
      this.chatbotService = new ChatbotService(
        whatsappService,
        aiService,
        chatHistoryService,
        webSocketService,
        appConfig.responseDelay,
        googleSheetsService,
        leadCaptureService,
        this.persistenceService,
        accessControlService
      );

      await this.chatbotService.initialize();

      // Start HTTP health/readiness probes for deployment platforms.
      this.healthService = new HealthService(appConfig.healthPort, () =>
        this.chatbotService ? this.chatbotService.getStatus() : null
      );
      this.healthService.start();

      logger.info('WhatsApp AI Chatbot initialized successfully! 🚀');
      this.logStartupInfo();
    } catch (error) {
      logger.error('Failed to initialize application', {
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      process.exit(1);
    }
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
