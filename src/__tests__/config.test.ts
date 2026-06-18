import {
  getAppConfig,
  getAIServiceConfig,
  getGoogleSheetsConfig,
  getNeonSearchConfig,
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
});
