/**
 * WhatsApp message types
 */
export interface WhatsAppMessage {
  id: string;
  from: string;
  to: string;
  timestamp: number;
  type:
    | 'text'
    | 'image'
    | 'video'
    | 'audio'
    | 'document'
    | 'location'
    | 'contact';
  content: string;
  isGroup: boolean;
  groupId?: string | undefined;
  senderName?: string | undefined;
  isFromBot?: boolean | undefined;
}

/**
 * Supported bot conversation roles
 */
export type BotRole = 'support' | 'sales';

/**
 * Chat history interface
 */
export interface ChatHistory {
  chatId: string;
  messages: WhatsAppMessage[];
  lastUpdated: number;
}

/**
 * AI response interface
 */
export interface AIResponse {
  message: string;
  confidence: number;
  context: string[];
  timestamp: number;
  role?: BotRole | undefined;
}

/**
 * WebSocket message types
 */
export interface WebSocketMessage {
  type: 'message' | 'status' | 'error' | 'connection';
  data: any;
  timestamp: number;
}

/**
 * Supported AI providers
 */
export type AIProvider = 'openai' | 'gemini';

/**
 * Application configuration interface (add provider)
 */
export interface AppConfig {
  port: number;
  healthPort: number;
  aiProvider: AIProvider;
  openaiApiKey?: string | undefined;
  openaiModel?: string | undefined;
  geminiApiKey?: string | undefined;
  geminiModel?: string | undefined;
  maxHistoryLength: number;
  responseDelay: number;
  logLevel: string;
  wsAuthToken?: string | undefined;
}

/**
 * WhatsApp connection status
 */
export enum ConnectionStatus {
  DISCONNECTED = 'disconnected',
  CONNECTING = 'connecting',
  CONNECTED = 'connected',
  AUTHENTICATING = 'authenticating',
  READY = 'ready',
}

/**
 * Backend-agnostic messaging transport contract.
 *
 * The whole app depends on this interface, never on a concrete WhatsApp
 * backend. Today it is implemented by the Baileys adapter (WhatsAppService);
 * a WhatsApp Cloud API adapter (CloudApiTransport) implements the same contract
 * so switching backends is a config change, not a rewrite.
 */
export type MessageDeliveryStatus =
  | 'accepted'
  | 'sent'
  | 'delivered'
  | 'read'
  | 'failed'
  | 'deleted'
  | 'unknown';

export interface MessagingSendResult {
  success: boolean;
  providerMessageIds: string[];
  error?: string | undefined;
}

export interface MessageDeliveryUpdate {
  providerMessageId: string;
  status: MessageDeliveryStatus;
  timestamp: number;
  recipientId?: string | undefined;
  conversationId?: string | undefined;
  pricingCategory?: string | undefined;
  errorCode?: string | undefined;
  errorMessage?: string | undefined;
}

export interface MessagingWebhookResult {
  statusCode: number;
  body: string | Record<string, unknown>;
}

export interface MessagingTransport {
  initialize(): Promise<void>;
  sendMessage(chatId: string, message: string): Promise<boolean>;
  sendMessageDetailed?(chatId: string, message: string): Promise<MessagingSendResult>;
  onMessage(handler: (message: WhatsAppMessage) => void): void;
  onConnectionStatusChange(handler: (status: ConnectionStatus) => void): void;
  onDeliveryStatus?(handler: (update: MessageDeliveryUpdate) => void): void;
  getConnectionStatus(): ConnectionStatus;
  isConnected(): boolean;
  disconnect(): Promise<void>;
  getChatParticipants(chatId: string): Promise<string[]>;
  /** Latest pending QR (Baileys only); null when not applicable or linked. */
  getCurrentQr?(): string | null;
  /** Cloud API webhook helpers; absent on socket transports. */
  getWebhookPath?(): string;
  verifyWebhookChallenge?(query: URLSearchParams): string | null;
  handleWebhookRequest?(
    rawBody: Buffer,
    headers: Record<string, string | string[] | undefined>
  ): Promise<MessagingWebhookResult>;
}

export type MessagingTransportKind = 'baileys' | 'cloud';

/**
 * Configuration for the messaging transport layer. `cloud*` fields are only
 * required when `kind === 'cloud'`.
 */
export interface MessagingConfig {
  kind: MessagingTransportKind;
  /** Persistent Baileys multi-file session directory. */
  baileysAuthDir: string;
  baileysReconnectBaseDelayMs: number;
  baileysReconnectMaxDelayMs: number;
  cloudPhoneNumberId: string;
  cloudAccessToken: string;
  cloudVerifyToken: string;
  cloudAppSecret: string;
  cloudApiVersion: string;
  cloudWebhookPath: string;
  cloudSendTimeoutMs: number;
  cloudWebhookMaxBodyBytes: number;
}


/**
 * Message processing result
 */
export interface MessageProcessingResult {
  success: boolean;
  response?: string;
  error?: string;
  processingTime: number;
}

/**
 * AI service configuration (add provider)
 */
export interface AIServiceConfig {
  provider: AIProvider;
  apiKey: string;
  model: string;
  maxTokens: number;
  temperature: number;
  systemPrompt: string;
}

/**
 * Google Sheets integration configuration
 */
export interface GoogleSheetsConfig {
  enabled: boolean;
  spreadsheetId: string;
  sheetName: string;
  credentialsJson?: string | undefined;
  credentialsPath?: string | undefined;
}

/**
 * Neon read-only search configuration
 */
export interface NeonSearchConfig {
  enabled: boolean;
  databaseUrl?: string | undefined;
  tableName: string;
  searchableColumns: string[];
  publicColumns: string[];
  limit: number;
}

/**
 * SHARH backend service-account integration. The bot never connects to the
 * production database directly; all canonical reads/writes go through these
 * scoped HTTP endpoints.
 */
export interface SharhApiConfig {
  enabled: boolean;
  baseUrl: string;
  serviceToken: string;
  timeoutMs: number;
  botId: string;
  allowNeonFallback: boolean;
  publicListingFields: string[];
  syncIntervalMs: number;
  syncMaxAttempts: number;
  syncBatchSize: number;
  contextCacheMs: number;
}

export type SharhSyncOperationKind =
  | 'message'
  | 'lead_snapshot'
  | 'access_request'
  | 'provider_event'
  | 'analytics';

export interface SharhApiRuntimeStatus {
  enabled: boolean;
  reachable: boolean | null;
  lastSuccessAt?: string | undefined;
  lastFailureAt?: string | undefined;
  lastError?: string | undefined;
}

/**
 * State persistence configuration
 */
export interface PersistenceConfig {
  enabled: boolean;
  filePath: string;
}

/**
 * Access control (allowlist + rate limit) configuration
 */
export interface AccessControlConfig {
  allowlistEnabled: boolean;
  allowedNumbers: string[];
  rateLimitEnabled: boolean;
  rateLimitMaxMessages: number;
  rateLimitWindowMs: number;
}

/**
 * Cost and abuse controls for AI-assisted sales conversations.
 * Straightforward funnel answers do not consume these allowances.
 */
export interface ConversationSafetyConfig {
  smartRoutingEnabled: boolean;
  maxAiCallsPerConversation: number;
  maxAiCallsPerNumberPerDay: number;
  maxInputChars: number;
  abuseCooldownMs: number;
  offTopicStrikesBeforeCooldown: number;
  minAiIntervalMs: number;
  conversationIdleResetMs: number;
}

/**
 * Logger levels
 */
export enum LogLevel {
  ERROR = 'error',
  WARN = 'warn',
  INFO = 'info',
  DEBUG = 'debug',
}

/**
 * Event types for the application
 */
export enum EventType {
  MESSAGE_RECEIVED = 'message_received',
  MESSAGE_SENT = 'message_sent',
  CONNECTION_STATUS_CHANGED = 'connection_status_changed',
  AI_RESPONSE_GENERATED = 'ai_response_generated',
  ERROR_OCCURRED = 'error_occurred',
}

/**
 * Event interface
 */
export interface AppEvent {
  type: EventType;
  data: any;
  timestamp: number;
}

/**
 * Health check interface
 */
export interface HealthStatus {
  status: 'healthy' | 'unhealthy';
  uptime: number;
  memory: {
    rss: number;
    heapTotal: number;
    heapUsed: number;
    external: number;
  };
  connections: number;
  lastError?: string;
}
