const mockConnect = jest.fn();
const mockQuery = jest.fn();
const mockClientConstructor = jest.fn();

jest.mock('@neondatabase/serverless', () => ({
  Client: jest.fn().mockImplementation((config: unknown) => {
    mockClientConstructor(config);
    return {
      connect: mockConnect,
      query: mockQuery,
    };
  }),
}));

import { NeonReadService } from '../services/neon-read.service';
import { NeonSearchConfig } from '../types';

const baseConfig = (
  overrides: Partial<NeonSearchConfig> = {}
): NeonSearchConfig => ({
  enabled: true,
  databaseUrl: 'postgresql://user:pass@host/db',
  tableName: 'asset_sales',
  searchableColumns: ['title', 'description'],
  limit: 5,
  ...overrides,
});

describe('NeonReadService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockConnect.mockResolvedValue(undefined);
    mockQuery.mockResolvedValue({
      rows: [{ id: 'l1', title: 'Vegan F&B chain' }],
    });
  });

  describe('when disabled', () => {
    it('reports not enabled and returns no rows', async () => {
      const service = new NeonReadService(baseConfig({ enabled: false }));

      expect(service.isEnabled()).toBe(false);
      await expect(service.searchListings('vegan')).resolves.toEqual([]);
      expect(mockQuery).not.toHaveBeenCalled();
    });

    it('is disabled when no database url is provided', () => {
      const service = new NeonReadService(
        baseConfig({ databaseUrl: undefined })
      );
      expect(service.isEnabled()).toBe(false);
    });
  });

  describe('searchListings', () => {
    it('runs a parameterized read-only query and returns rows', async () => {
      const service = new NeonReadService(baseConfig());

      const rows = await service.searchListings('vegan');

      expect(rows).toEqual([{ id: 'l1', title: 'Vegan F&B chain' }]);
      expect(mockConnect).toHaveBeenCalledTimes(1);

      const [sql, params] = mockQuery.mock.calls[0];
      expect(sql).toMatch(/^SELECT \* FROM "asset_sales" WHERE/);
      expect(sql).toContain('ILIKE');
      expect(sql).toContain('$1');
      expect(sql).toContain('LIMIT 5');
      expect(params).toEqual(['vegan']);
    });

    it('connects only once across multiple searches', async () => {
      const service = new NeonReadService(baseConfig());

      await service.searchListings('one');
      await service.searchListings('two');

      expect(mockConnect).toHaveBeenCalledTimes(1);
      expect(mockQuery).toHaveBeenCalledTimes(2);
    });

    it('returns an empty array for blank queries without hitting the db', async () => {
      const service = new NeonReadService(baseConfig());

      await expect(service.searchListings('   ')).resolves.toEqual([]);
      expect(mockQuery).not.toHaveBeenCalled();
    });

    it('ignores unsafe column identifiers and returns empty when none remain', async () => {
      const service = new NeonReadService(
        baseConfig({ searchableColumns: ['title; DROP TABLE x', '1bad'] })
      );

      await expect(service.searchListings('vegan')).resolves.toEqual([]);
      expect(mockQuery).not.toHaveBeenCalled();
    });

    it('returns empty array when the query fails', async () => {
      mockQuery.mockRejectedValueOnce(new Error('permission denied'));
      const service = new NeonReadService(baseConfig());

      await expect(service.searchListings('vegan')).resolves.toEqual([]);
    });

    it('rejects an unsafe table name safely', async () => {
      const service = new NeonReadService(
        baseConfig({ tableName: 'asset_sales; DROP TABLE x' })
      );

      await expect(service.searchListings('vegan')).resolves.toEqual([]);
      expect(mockQuery).not.toHaveBeenCalled();
    });
  });

  describe('database url normalization', () => {
    it('converts python-style asyncpg URLs to a standard postgresql URL', () => {
      new NeonReadService(
        baseConfig({
          databaseUrl: 'postgresql+asyncpg://bot_ro:pw@host.neon.tech/neondb',
        })
      );

      expect(mockClientConstructor).toHaveBeenCalledWith(
        expect.objectContaining({
          connectionString: 'postgresql://bot_ro:pw@host.neon.tech/neondb',
          ssl: true,
        })
      );
    });
  });
});
