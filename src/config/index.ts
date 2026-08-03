import dotenv from 'dotenv';
import Joi from 'joi';
import {
  AppConfig,
  AIServiceConfig,
  AIProvider,
  GoogleSheetsConfig,
  NeonSearchConfig,
  PersistenceConfig,
  AccessControlConfig,
  MessagingConfig,
  HandoffConfig,
} from '../types';

// Load environment variables
dotenv.config();

/**
 * Environment variables validation schema
 */
const booleanFlag = (): Joi.BooleanSchema =>
  Joi.boolean()
    .truthy('true')
    .truthy('1')
    .truthy('yes')
    .falsy('false')
    .falsy('0')
    .falsy('no');

const envSchema = Joi.object({
  PORT: Joi.number().default(3000),
  HEALTH_PORT: Joi.number().default(3001),
  AI_PROVIDER: Joi.string().valid('openai', 'gemini').default('openai'),
  // Provider-specific keys are validated conditionally below.
  OPENAI_API_KEY: Joi.string()
    .allow('')
    .when('AI_PROVIDER', {
      is: 'openai',
      then: Joi.string().min(1).required().messages({
        'any.required': 'OPENAI_API_KEY is required when AI_PROVIDER=openai',
        'string.empty': 'OPENAI_API_KEY is required when AI_PROVIDER=openai',
      }),
    }),
  OPENAI_MODEL: Joi.string().default('gpt-3.5-turbo'),
  GEMINI_API_KEY: Joi.string()
    .allow('')
    .when('AI_PROVIDER', {
      is: 'gemini',
      then: Joi.string().min(1).required().messages({
        'any.required': 'GEMINI_API_KEY is required when AI_PROVIDER=gemini',
        'string.empty': 'GEMINI_API_KEY is required when AI_PROVIDER=gemini',
      }),
    }),
  GEMINI_MODEL: Joi.string().default('gemini-pro'),
  MAX_HISTORY_LENGTH: Joi.number().default(50),
  RESPONSE_DELAY: Joi.number().default(1000),
  LOG_LEVEL: Joi.string()
    .valid('error', 'warn', 'info', 'debug')
    .default('info'),
  AI_MAX_TOKENS: Joi.number().default(150),
  AI_TEMPERATURE: Joi.number().min(0).max(2).default(0.7),
  WS_AUTH_TOKEN: Joi.string().allow(''),
  GOOGLE_SHEETS_ENABLED: booleanFlag().default(false),
  // When Sheets is enabled, require a spreadsheet id and at least one credential source.
  GOOGLE_SHEETS_SPREADSHEET_ID: Joi.string()
    .allow('')
    .when('GOOGLE_SHEETS_ENABLED', {
      is: true,
      then: Joi.string().min(1).required().messages({
        'any.required':
          'GOOGLE_SHEETS_SPREADSHEET_ID is required when GOOGLE_SHEETS_ENABLED=true',
        'string.empty':
          'GOOGLE_SHEETS_SPREADSHEET_ID is required when GOOGLE_SHEETS_ENABLED=true',
      }),
    }),
  GOOGLE_SHEETS_SHEET_NAME: Joi.string().default('Leads'),
  GOOGLE_SHEETS_CREDENTIALS_JSON: Joi.string().allow(''),
  GOOGLE_SHEETS_CREDENTIALS_PATH: Joi.string().allow(''),
  NEON_SEARCH_ENABLED: booleanFlag().default(false),
  // When Neon search is enabled, a connection string is mandatory.
  NEON_READONLY_DATABASE_URL: Joi.string()
    .allow('')
    .when('NEON_SEARCH_ENABLED', {
      is: true,
      then: Joi.string().min(1).required().messages({
        'any.required':
          'NEON_READONLY_DATABASE_URL is required when NEON_SEARCH_ENABLED=true',
        'string.empty':
          'NEON_READONLY_DATABASE_URL is required when NEON_SEARCH_ENABLED=true',
      }),
    }),
  NEON_SEARCH_TABLE_NAME: Joi.string().default('business_listings'),
  NEON_SEARCHABLE_COLUMNS: Joi.string().default('title,description'),
  NEON_SEARCH_LIMIT: Joi.number().integer().min(1).max(20).default(5),
  PERSISTENCE_ENABLED: booleanFlag().default(true),
  PERSISTENCE_PATH: Joi.string().default('./.state/state.json'),
  ALLOWLIST_ENABLED: booleanFlag().default(false),
  ALLOWED_NUMBERS: Joi.string().allow(''),
  RATE_LIMIT_ENABLED: booleanFlag().default(true),
  RATE_LIMIT_MAX_MESSAGES: Joi.number().integer().min(1).default(20),
  RATE_LIMIT_WINDOW_MS: Joi.number().integer().min(1000).default(60000),
  WHATSAPP_TRANSPORT: Joi.string().valid('baileys', 'cloud').default('baileys'),
  WHATSAPP_CLOUD_PHONE_NUMBER_ID: Joi.string().allow(''),
  WHATSAPP_CLOUD_ACCESS_TOKEN: Joi.string().allow(''),
  WHATSAPP_CLOUD_VERIFY_TOKEN: Joi.string().allow(''),
  WHATSAPP_CLOUD_API_VERSION: Joi.string().default('v21.0'),
  WHATSAPP_AUTH_DIR: Joi.string().default('./auth_info_baileys'),
  NEON_PUBLIC_COLUMNS: Joi.string().allow(''),
  HANDOFF_WHATSAPP_JIDS: Joi.string().allow(''),
  ROLE_SWITCH_ENABLED: booleanFlag().default(false),
  OPERATOR_JIDS: Joi.string().allow(''),
  IGNORE_GROUPS: booleanFlag().default(true),
}).unknown();

/**
 * Validate and get environment variables
 */
const validateEnv = (): void => {
  const { error } = envSchema.validate(process.env, { abortEarly: false });
  if (error) {
    const details = error.details.map(detail => detail.message).join('; ');
    throw new Error(`Environment validation error: ${details}`);
  }

  // When Sheets is enabled, ensure at least one credential source is present.
  const sheetsEnabled = parseBoolean(
    process.env['GOOGLE_SHEETS_ENABLED'],
    false
  );
  if (sheetsEnabled) {
    const hasJson = Boolean(process.env['GOOGLE_SHEETS_CREDENTIALS_JSON']);
    const hasPath = Boolean(process.env['GOOGLE_SHEETS_CREDENTIALS_PATH']);
    if (!hasJson && !hasPath) {
      throw new Error(
        'Environment validation error: GOOGLE_SHEETS_CREDENTIALS_JSON or GOOGLE_SHEETS_CREDENTIALS_PATH is required when GOOGLE_SHEETS_ENABLED=true'
      );
    }
  }
};

const parseBoolean = (
  value: string | undefined,
  fallback: boolean = false
): boolean => {
  if (value === undefined) {
    return fallback;
  }

  return /^(true|1|yes)$/i.test(value.trim());
};

/**
 * Get application configuration
 */
export const getAppConfig = (): AppConfig => {
  validateEnv();
  const aiProvider = (process.env['AI_PROVIDER'] as AIProvider) || 'openai';
  return {
    port: parseInt(process.env['PORT'] || '3000', 10),
    healthPort: parseInt(process.env['HEALTH_PORT'] || '3001', 10),
    aiProvider,
    openaiApiKey: process.env['OPENAI_API_KEY'],
    openaiModel: process.env['OPENAI_MODEL'],
    geminiApiKey: process.env['GEMINI_API_KEY'],
    geminiModel: process.env['GEMINI_MODEL'],
    maxHistoryLength: parseInt(process.env['MAX_HISTORY_LENGTH'] || '50', 10),
    responseDelay: parseInt(process.env['RESPONSE_DELAY'] || '1000', 10),
    logLevel: process.env['LOG_LEVEL'] || 'info',
    wsAuthToken: process.env['WS_AUTH_TOKEN'] || undefined,
  };
};

/**
 * Get AI service configuration
 */
export const getAIServiceConfig = (): AIServiceConfig => {
  validateEnv();
  const provider = (process.env['AI_PROVIDER'] as AIProvider) || 'openai';
  let apiKey = '';
  let model = '';
  if (provider === 'openai') {
    apiKey = process.env['OPENAI_API_KEY'] || '';
    model = process.env['OPENAI_MODEL'] || 'gpt-3.5-turbo';
  } else if (provider === 'gemini') {
    apiKey = process.env['GEMINI_API_KEY'] || '';
    model = process.env['GEMINI_MODEL'] || 'gemini-pro';
  }
  return {
    provider,
    apiKey,
    model,
    maxTokens: parseInt(process.env['AI_MAX_TOKENS'] || '150', 10),
    temperature: parseFloat(process.env['AI_TEMPERATURE'] || '0.3'),
    systemPrompt: `You are a helpful WhatsApp AI assistant. You should:\n- Be friendly and conversational\n- Provide helpful and accurate responses\n- Keep responses concise but informative\n- Use appropriate emojis when suitable\n- Ask clarifying questions when needed\n- Maintain context from the conversation history`,
  };
};

/**
 * Get Google Sheets configuration
 */
export const getGoogleSheetsConfig = (): GoogleSheetsConfig => {
  validateEnv();

  return {
    enabled: parseBoolean(process.env['GOOGLE_SHEETS_ENABLED'], false),
    spreadsheetId: process.env['GOOGLE_SHEETS_SPREADSHEET_ID'] || '',
    sheetName: process.env['GOOGLE_SHEETS_SHEET_NAME'] || 'Leads',
    credentialsJson: process.env['GOOGLE_SHEETS_CREDENTIALS_JSON'] || undefined,
    credentialsPath: process.env['GOOGLE_SHEETS_CREDENTIALS_PATH'] || undefined,
  };
};

/**
 * Get Neon read-only search configuration
 */
export const getNeonSearchConfig = (): NeonSearchConfig => {
  validateEnv();

  const searchableColumns = (
    process.env['NEON_SEARCHABLE_COLUMNS'] || 'title,description'
  )
    .split(',')
    .map(column => column.trim())
    .filter(Boolean);

  // Columns the bot is allowed to reveal to a client. Defaults to the
  // searchable columns so nothing internal is exposed unless explicitly listed.
  const publicColumns = (
    process.env['NEON_PUBLIC_COLUMNS'] || searchableColumns.join(',')
  )
    .split(',')
    .map(column => column.trim())
    .filter(Boolean);

  return {
    enabled: parseBoolean(process.env['NEON_SEARCH_ENABLED'], false),
    databaseUrl: process.env['NEON_READONLY_DATABASE_URL'] || undefined,
    tableName: process.env['NEON_SEARCH_TABLE_NAME'] || 'business_listings',
    searchableColumns,
    publicColumns,
    limit: parseInt(process.env['NEON_SEARCH_LIMIT'] || '5', 10),
  };
};

/**
 * Get state persistence configuration
 */
export const getPersistenceConfig = (): PersistenceConfig => {
  validateEnv();

  return {
    enabled: parseBoolean(process.env['PERSISTENCE_ENABLED'], true),
    filePath: process.env['PERSISTENCE_PATH'] || './.state/state.json',
  };
};

/**
 * Get access control (allowlist + rate limit) configuration
 */
export const getAccessControlConfig = (): AccessControlConfig => {
  validateEnv();

  const allowedNumbers = (process.env['ALLOWED_NUMBERS'] || '')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean);

  return {
    allowlistEnabled: parseBoolean(process.env['ALLOWLIST_ENABLED'], false),
    allowedNumbers,
    rateLimitEnabled: parseBoolean(process.env['RATE_LIMIT_ENABLED'], true),
    rateLimitMaxMessages: parseInt(
      process.env['RATE_LIMIT_MAX_MESSAGES'] || '20',
      10
    ),
    rateLimitWindowMs: parseInt(
      process.env['RATE_LIMIT_WINDOW_MS'] || '60000',
      10
    ),
  };
};

/**
 * Get messaging transport configuration (backend selection + Cloud API creds)
 */
export const getMessagingConfig = (): MessagingConfig => {
  validateEnv();

  const kind =
    process.env['WHATSAPP_TRANSPORT'] === 'cloud' ? 'cloud' : 'baileys';

  return {
    kind,
    cloudPhoneNumberId: process.env['WHATSAPP_CLOUD_PHONE_NUMBER_ID'] || '',
    cloudAccessToken: process.env['WHATSAPP_CLOUD_ACCESS_TOKEN'] || '',
    cloudVerifyToken: process.env['WHATSAPP_CLOUD_VERIFY_TOKEN'] || '',
    cloudApiVersion: process.env['WHATSAPP_CLOUD_API_VERSION'] || 'v21.0',
  };
};

/**
 * Get manager handoff configuration (WhatsApp ids notified on qualify/escalate)
 */
export const getHandoffConfig = (): HandoffConfig => {
  validateEnv();

  const jids = (process.env['HANDOFF_WHATSAPP_JIDS'] || '')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean);

  return { jids };
};

/**
 * Check if running in development mode
 */
export const isDevelopment = (): boolean => {
  return process.env['NODE_ENV'] === 'development';
};

/**
 * Check if running in production mode
 */
export const isProduction = (): boolean => {
  return process.env['NODE_ENV'] === 'production';
};
