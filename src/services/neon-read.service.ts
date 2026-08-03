import { Client } from '@neondatabase/serverless';
import { NeonSearchConfig } from '../types';
import { logger } from '../utils/logger';

type SearchResultRow = Record<string, unknown>;

/**
 * Read-only Neon search service used by sales mode.
 */
export class NeonReadService {
  private readonly config: NeonSearchConfig;
  private readonly client: Client | null;
  private isConnected: boolean = false;

  constructor(config: NeonSearchConfig) {
    this.config = config;

    if (!config.enabled || !config.databaseUrl) {
      this.client = null;
      return;
    }

    const normalizedUrl = this.normalizeDatabaseUrl(config.databaseUrl);
    this.client = new Client({ connectionString: normalizedUrl, ssl: true });
  }

  /**
   * Search configured table by partial matches across configured columns.
   */
  async searchListings(query: string): Promise<SearchResultRow[]> {
    if (!this.config.enabled || !this.client) {
      return [];
    }

    const cleanQuery = query.trim();
    if (!cleanQuery) {
      return [];
    }

    try {
      const tableRef = this.toQualifiedIdentifier(this.config.tableName);
      const matchColumns = this.config.searchableColumns.filter(column =>
        this.isSafeIdentifier(column)
      );
      if (matchColumns.length === 0) {
        logger.warn(
          'Neon search disabled for request because no valid searchable columns are configured'
        );
        return [];
      }

      const publicColumns = this.config.publicColumns.filter(column =>
        this.isSafeIdentifier(column)
      );
      if (publicColumns.length === 0) {
        logger.warn(
          'Neon search disabled for request because no valid public columns are configured'
        );
        return [];
      }

      const selectClause = publicColumns
        .map(column => this.quoteIdentifier(column))
        .join(', ');

      const whereClause = matchColumns
        .map(
          column =>
            `${this.quoteIdentifier(column)}::text ILIKE '%' || $1 || '%'`
        )
        .join(' OR ');

      // Only ever return a single best match, and only the allowlisted public
      // columns — internal fields are never selected, so they cannot leak into
      // the model context.
      const querySql = `SELECT ${selectClause} FROM ${tableRef} WHERE ${whereClause} LIMIT 1`;
      await this.ensureConnected();
      const result = await this.client.query(querySql, [cleanQuery]);
      return result.rows as SearchResultRow[];
    } catch (error) {
      logger.error('Neon read-only search failed', {
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      return [];
    }
  }

  /**
   * Whether the service has enough configuration to query Neon.
   */
  isEnabled(): boolean {
    return this.config.enabled && Boolean(this.client);
  }

  private async ensureConnected(): Promise<void> {
    if (!this.client || this.isConnected) {
      return;
    }

    await this.client.connect();
    this.isConnected = true;
  }

  private normalizeDatabaseUrl(databaseUrl: string): string {
    // Some dashboards export python-style URLs like postgresql+asyncpg://...
    // The Neon JS client expects postgres:// or postgresql://.
    return databaseUrl.replace(/^postgresql\+asyncpg:\/\//i, 'postgresql://');
  }

  private isSafeIdentifier(value: string): boolean {
    return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);
  }

  private quoteIdentifier(identifier: string): string {
    if (!this.isSafeIdentifier(identifier)) {
      throw new Error(`Invalid SQL identifier: ${identifier}`);
    }
    return `"${identifier}"`;
  }

  private toQualifiedIdentifier(identifier: string): string {
    const parts = identifier
      .split('.')
      .map(part => part.trim())
      .filter(Boolean);
    if (parts.length === 0 || parts.length > 2) {
      throw new Error(`Invalid table identifier: ${identifier}`);
    }

    return parts.map(part => this.quoteIdentifier(part)).join('.');
  }
}
