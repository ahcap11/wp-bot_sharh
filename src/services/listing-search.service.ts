import type { NeonReadService } from './neon-read.service';
import type { SharhApiService } from './sharh-api.service';
import type { PublicListingRow } from './sharh-api.service';
import { logger } from '../utils/logger';

export interface ListingSearchProvider {
  isEnabled(): boolean;
  searchListings(query: string): Promise<PublicListingRow[]>;
}

/**
 * Canonical listing lookup: SHARH API first, optional read-only Neon fallback
 * only when explicitly enabled for migration/development.
 */
export class ListingSearchService implements ListingSearchProvider {
  constructor(
    private readonly sharhApi: SharhApiService,
    private readonly neonFallback: NeonReadService | null,
    private readonly allowNeonFallback: boolean
  ) {}

  isEnabled(): boolean {
    return (
      this.sharhApi.isEnabled() ||
      (this.allowNeonFallback && Boolean(this.neonFallback?.isEnabled()))
    );
  }

  async searchListings(query: string): Promise<PublicListingRow[]> {
    const exactCode = query.toUpperCase().match(/\bSH-\d{1,12}\b/)?.[0];

    if (this.sharhApi.isEnabled()) {
      const rows = await this.sharhApi.searchPublicListings(query);
      if (rows.length > 0 || exactCode || !this.allowNeonFallback) {
        return rows;
      }
    }

    if (!this.allowNeonFallback || !this.neonFallback?.isEnabled()) {
      return [];
    }

    for (const term of this.buildFallbackTerms(query)) {
      const rows = await this.neonFallback.searchListings(term);
      if (rows.length > 0) {
        logger.warn('Used legacy Neon listing fallback', { term });
        return rows;
      }
    }

    return [];
  }

  private buildFallbackTerms(query: string): string[] {
    const code = query.toUpperCase().match(/\bSH-\d{1,12}\b/)?.[0];
    if (code) {
      return [code];
    }

    const stopWords = new Set([
      'want',
      'need',
      'looking',
      'business',
      'listing',
      'buy',
      'sell',
      'please',
      'about',
      'show',
      'tell',
      'with',
      'under',
      'from',
      'that',
      'this',
    ]);
    const terms = query
      .toLowerCase()
      .replace(/[^\p{L}\p{N}-]+/gu, ' ')
      .split(/\s+/)
      .map(value => value.trim())
      .filter(value => value.length >= 3 && !stopWords.has(value));

    return Array.from(new Set(terms)).slice(0, 5);
  }
}
