import {
  getAppConfig,
  getAIServiceConfig,
  getGoogleSheetsConfig,
  getNeonSearchConfig,
  getSharhApiConfig,
  getMessagingConfig,
} from '../config';

/**
 * The config getters validate `process.env` on every call, so each test
 * installs a clean, controlled environment and restores it afterwards.
 */
describe('config', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = {};
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  describe('getAppConfig', () => {
    it('applies defaults when only required values are present', () => {
      process.env['AI_PROVIDER'] = 'openai';
      process.env['OPENAI_API_KEY'] = 'sk-test';

      const config = getAppConfig();

      expect(config.port).toBe(3000);
      expect(config.healthPort).toBe(3001);
      expect(config.aiProvider).toBe('openai');
      expect(config.maxHistoryLength).toBe(50);
      expect(config.logLevel).toBe('info');
      expect(config.wsAuthToken).toBeUndefined();
    });

    it('reads overrides including ws auth token', () => {
      process.env['AI_PROVIDER'] = 'openai';
      process.env['OPENAI_API_KEY'] = 'sk-test';
      process.env['PORT'] = '9090';
      process.env['HEALTH_PORT'] = '9091';
      process.env['WS_AUTH_TOKEN'] = 'secret-token';

      const config = getAppConfig();

      expect(config.port).toBe(9090);
      expect(config.healthPort).toBe(9091);
      expect(config.wsAuthToken).toBe('secret-token');
    });
  });

  describe('fail-fast validation', () => {
    it('throws when AI_PROVIDER=openai but OPENAI_API_KEY is missing', () => {
      process.env['AI_PROVIDER'] = 'openai';

      expect(() => getAppConfig()).toThrow(/OPENAI_API_KEY is required/);
    });

    it('throws when AI_PROVIDER=gemini but GEMINI_API_KEY is missing', () => {
      process.env['AI_PROVIDER'] = 'gemini';

      expect(() => getAIServiceConfig()).toThrow(/GEMINI_API_KEY is required/);
    });

    it('throws when Google Sheets is enabled without a spreadsheet id', () => {
      process.env['AI_PROVIDER'] = 'openai';
      process.env['OPENAI_API_KEY'] = 'sk-test';
      process.env['GOOGLE_SHEETS_ENABLED'] = 'true';

      expect(() => getGoogleSheetsConfig()).toThrow(
        /GOOGLE_SHEETS_SPREADSHEET_ID is required/
      );
    });

    it('throws when Google Sheets is enabled without credentials', () => {
      process.env['AI_PROVIDER'] = 'openai';
      process.env['OPENAI_API_KEY'] = 'sk-test';
      process.env['GOOGLE_SHEETS_ENABLED'] = 'true';
      process.env['GOOGLE_SHEETS_SPREADSHEET_ID'] = 'sheet-123';

      expect(() => getGoogleSheetsConfig()).toThrow(
        /CREDENTIALS_JSON or .*CREDENTIALS_PATH is required/
      );
    });

    it('throws when Neon search is enabled without a database url', () => {
      process.env['AI_PROVIDER'] = 'openai';
      process.env['OPENAI_API_KEY'] = 'sk-test';
      process.env['NEON_SEARCH_ENABLED'] = 'true';

      expect(() => getNeonSearchConfig()).toThrow(
        /NEON_READONLY_DATABASE_URL is required/
      );
    });


    it('requires all Cloud API security settings when cloud transport is enabled', () => {
      process.env['AI_PROVIDER'] = 'openai';
      process.env['OPENAI_API_KEY'] = 'sk-test';
      process.env['WHATSAPP_TRANSPORT'] = 'cloud';
      process.env['WHATSAPP_CLOUD_PHONE_NUMBER_ID'] = '12345';
      process.env['WHATSAPP_CLOUD_ACCESS_TOKEN'] = 'token';
      process.env['WHATSAPP_CLOUD_VERIFY_TOKEN'] = 'verify';

      expect(() => getMessagingConfig()).toThrow(
        /WHATSAPP_CLOUD_APP_SECRET required/
      );
    });

    it('requires a leading slash for the Cloud API webhook path', () => {
      process.env['AI_PROVIDER'] = 'openai';
      process.env['OPENAI_API_KEY'] = 'sk-test';
      process.env['WHATSAPP_TRANSPORT'] = 'cloud';
      process.env['WHATSAPP_CLOUD_PHONE_NUMBER_ID'] = '12345';
      process.env['WHATSAPP_CLOUD_ACCESS_TOKEN'] = 'token';
      process.env['WHATSAPP_CLOUD_VERIFY_TOKEN'] = 'verify';
      process.env['WHATSAPP_CLOUD_APP_SECRET'] = 'secret';
      process.env['WHATSAPP_CLOUD_WEBHOOK_PATH'] = 'webhook';

      expect(() => getMessagingConfig()).toThrow(/must start with \//);
    });

    it('throws when SHARH API is enabled without URL and token', () => {
      process.env['AI_PROVIDER'] = 'openai';
      process.env['OPENAI_API_KEY'] = 'sk-test';
      process.env['SHARH_API_ENABLED'] = 'true';

      expect(() => getSharhApiConfig()).toThrow(/SHARH_API_BASE_URL is required/);
      expect(() => getSharhApiConfig()).toThrow(
        /SHARH_API_SERVICE_TOKEN is required/
      );
    });
    it('requires persistence when SHARH API synchronization is enabled', () => {
      process.env['AI_PROVIDER'] = 'openai';
      process.env['OPENAI_API_KEY'] = 'sk-test';
      process.env['SHARH_API_ENABLED'] = 'true';
      process.env['SHARH_API_BASE_URL'] = 'https://sharh.example.com';
      process.env['SHARH_API_SERVICE_TOKEN'] = 'service-token';
      process.env['PERSISTENCE_ENABLED'] = 'false';

      expect(() => getSharhApiConfig()).toThrow(
        /PERSISTENCE_ENABLED must remain true/
      );
    });

    it('requires HTTPS for SHARH API in production', () => {
      process.env['AI_PROVIDER'] = 'openai';
      process.env['OPENAI_API_KEY'] = 'sk-test';
      process.env['NODE_ENV'] = 'production';
      process.env['QR_ACCESS_TOKEN'] = 'test-qr-access-token-123456789';
      process.env['SHARH_API_ENABLED'] = 'true';
      process.env['SHARH_API_BASE_URL'] = 'http://sharh.example.com';
      process.env['SHARH_API_SERVICE_TOKEN'] = 'service-token';

      expect(() => getSharhApiConfig()).toThrow(/must use HTTPS/);
    });

  });

  describe('getAIServiceConfig', () => {
    it('selects the gemini provider settings', () => {
      process.env['AI_PROVIDER'] = 'gemini';
      process.env['GEMINI_API_KEY'] = 'gemini-key';
      process.env['GEMINI_MODEL'] = 'gemini-1.5';

      const config = getAIServiceConfig();

      expect(config.provider).toBe('gemini');
      expect(config.apiKey).toBe('gemini-key');
      expect(config.model).toBe('gemini-1.5');
    });
  });

  describe('getNeonSearchConfig', () => {
    it('parses searchable columns and trims whitespace', () => {
      process.env['AI_PROVIDER'] = 'openai';
      process.env['OPENAI_API_KEY'] = 'sk-test';
      process.env['NEON_SEARCH_ENABLED'] = 'true';
      process.env['NEON_READONLY_DATABASE_URL'] =
        'postgresql://user:pass@host/db';
      process.env['NEON_SEARCHABLE_COLUMNS'] = ' title , description ,sector ';

      const config = getNeonSearchConfig();

      expect(config.enabled).toBe(true);
      expect(config.databaseUrl).toBe('postgresql://user:pass@host/db');
      expect(config.searchableColumns).toEqual([
        'title',
        'description',
        'sector',
      ]);
    });

    it('defaults to disabled with no database url', () => {
      process.env['AI_PROVIDER'] = 'openai';
      process.env['OPENAI_API_KEY'] = 'sk-test';

      const config = getNeonSearchConfig();

      expect(config.enabled).toBe(false);
      expect(config.databaseUrl).toBeUndefined();
    });
  });


  describe('getMessagingConfig', () => {
    it('defaults to the Baileys pilot transport and parses session settings', () => {
      process.env['AI_PROVIDER'] = 'openai';
      process.env['OPENAI_API_KEY'] = 'sk-test';
      process.env['WHATSAPP_AUTH_DIR'] = '/app/data/whatsapp-auth';
      process.env['BAILEYS_RECONNECT_BASE_DELAY_MS'] = '7000';
      process.env['BAILEYS_RECONNECT_MAX_DELAY_MS'] = '90000';

      const config = getMessagingConfig();

      expect(config.kind).toBe('baileys');
      expect(config.baileysAuthDir).toBe('/app/data/whatsapp-auth');
      expect(config.baileysReconnectBaseDelayMs).toBe(7000);
      expect(config.baileysReconnectMaxDelayMs).toBe(90000);
    });

    it('requires a protected QR page for Baileys in production', () => {
      process.env['AI_PROVIDER'] = 'openai';
      process.env['OPENAI_API_KEY'] = 'sk-test';
      process.env['NODE_ENV'] = 'production';
      process.env['WHATSAPP_TRANSPORT'] = 'baileys';

      expect(() => getMessagingConfig()).toThrow(/QR_ACCESS_TOKEN/);
    });

    it('parses the official Cloud API settings', () => {
      process.env['AI_PROVIDER'] = 'openai';
      process.env['OPENAI_API_KEY'] = 'sk-test';
      process.env['WHATSAPP_TRANSPORT'] = 'cloud';
      process.env['WHATSAPP_CLOUD_PHONE_NUMBER_ID'] = '12345';
      process.env['WHATSAPP_CLOUD_ACCESS_TOKEN'] = 'token';
      process.env['WHATSAPP_CLOUD_VERIFY_TOKEN'] = 'verify';
      process.env['WHATSAPP_CLOUD_APP_SECRET'] = 'secret';

      const config = getMessagingConfig();

      expect(config.kind).toBe('cloud');
      expect(config.cloudWebhookPath).toBe('/webhooks/whatsapp');
      expect(config.cloudSendTimeoutMs).toBe(10000);
      expect(config.cloudWebhookMaxBodyBytes).toBe(1048576);
    });
  });

  describe('getSharhApiConfig', () => {
    it('parses canonical integration settings', () => {
      process.env['AI_PROVIDER'] = 'openai';
      process.env['OPENAI_API_KEY'] = 'sk-test';
      process.env['SHARH_API_ENABLED'] = 'true';
      process.env['SHARH_API_BASE_URL'] = 'https://sharh.example.com/';
      process.env['SHARH_API_SERVICE_TOKEN'] = 'service-token';
      process.env['SHARH_API_ALLOW_NEON_FALLBACK'] = 'false';

      const config = getSharhApiConfig();

      expect(config.enabled).toBe(true);
      expect(config.baseUrl).toBe('https://sharh.example.com');
      expect(config.serviceToken).toBe('service-token');
      expect(config.allowNeonFallback).toBe(false);
      expect(config.publicListingFields).toContain('public_code');
    });

    it('keeps legacy fallback available while SHARH API is disabled', () => {
      process.env['AI_PROVIDER'] = 'openai';
      process.env['OPENAI_API_KEY'] = 'sk-test';

      expect(getSharhApiConfig().allowNeonFallback).toBe(true);
    });
  });

});
