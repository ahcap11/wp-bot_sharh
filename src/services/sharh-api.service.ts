import { createHash } from 'crypto';
import type {
  SharhApiConfig,
  SharhApiRuntimeStatus,
  WhatsAppMessage,
} from '../types';
import type { LeadCaptureRecord } from './lead-capture.service';
import { logger } from '../utils/logger';

export type PublicListingRow = Record<string, unknown>;

export interface IndicativeValuationResult {
  low: number;
  mid: number;
  high: number;
  currency: string;
  formattedRange: string;
}

interface ApiResult<T> {
  ok: boolean;
  status: number;
  data?: T | undefined;
  error?: string | undefined;
}

interface CachedContext {
  expiresAt: number;
  value: string;
}

/**
 * Scoped SHARH backend client.
 *
 * The WhatsApp bot never receives database credentials and never writes to
 * PostgreSQL directly. The backend remains the policy boundary for listing
 * visibility, contact identity, NDA/access rules, audit, and ownership.
 */
export class SharhApiService {
  private readonly config: SharhApiConfig;
  private readonly contextCache: Map<string, CachedContext> = new Map();
  private reachable: boolean | null = null;
  private lastSuccessAt?: string | undefined;
  private lastFailureAt?: string | undefined;
  private lastError?: string | undefined;
  private failureCooldownUntil: number = 0;

  constructor(config: SharhApiConfig) {
    this.config = config;
  }

  isEnabled(): boolean {
    return this.config.enabled;
  }

  getConfig(): SharhApiConfig {
    return this.config;
  }

  getRuntimeStatus(): SharhApiRuntimeStatus {
    return {
      enabled: this.config.enabled,
      reachable: this.reachable,
      ...(this.lastSuccessAt ? { lastSuccessAt: this.lastSuccessAt } : {}),
      ...(this.lastFailureAt ? { lastFailureAt: this.lastFailureAt } : {}),
      ...(this.lastError ? { lastError: this.lastError } : {}),
    };
  }

  async checkHealth(): Promise<boolean> {
    if (!this.config.enabled) {
      return true;
    }

    const result = await this.request<unknown>(
      'GET',
      '/api/v1/bot/health',
      undefined,
      undefined,
      true
    );
    return result.ok;
  }

  async searchPublicListings(query: string): Promise<PublicListingRow[]> {
    if (!this.config.enabled) {
      return [];
    }

    const cleanQuery = query.trim();
    if (!cleanQuery) {
      return [];
    }

    const code = this.extractPublicCode(cleanQuery);
    if (code) {
      const result = await this.request<unknown>(
        'GET',
        `/api/v1/bot/listings/by-public-code/${encodeURIComponent(code)}`
      );
      if (!result.ok || result.data === undefined) {
        return [];
      }
      const rows = this.extractRows(result.data);
      return rows.slice(0, 1).map(row => this.filterPublicListing(row));
    }

    const params = new URLSearchParams({ q: cleanQuery, limit: '3' });
    const result = await this.request<unknown>(
      'GET',
      `/api/v1/bot/listings/search?${params.toString()}`
    );
    if (!result.ok || result.data === undefined) {
      return [];
    }

    return this.extractRows(result.data)
      .slice(0, 3)
      .map(row => this.filterPublicListing(row));
  }

  async searchBuyerMatches(
    record: LeadCaptureRecord,
    limit: number = 3
  ): Promise<PublicListingRow[]> {
    if (!this.config.enabled || record.inquiryPurpose !== 'buying') {
      return [];
    }

    const params = new URLSearchParams();
    const cleanSector = record.businessType.trim();
    const cleanLocation = record.buyerLocation.trim();
    const maxBudget = this.parseAedUpperBound(record.buyerBudgetAed);

    if (cleanSector) {
      params.set('q', cleanSector);
      params.set('sector', cleanSector);
    }
    if (cleanLocation && !/unknown|to confirm/i.test(cleanLocation)) {
      params.set('emirate', cleanLocation);
    }
    if (maxBudget !== null) {
      params.set('max_price_aed', String(maxBudget));
    }
    params.set('limit', String(Math.max(1, Math.min(3, limit))));

    const result = await this.request<unknown>(
      'GET',
      `/api/v1/bot/listings/search?${params.toString()}`
    );
    if (!result.ok || result.data === undefined) {
      return [];
    }

    return this.extractRows(result.data)
      .slice(0, Math.max(1, Math.min(3, limit)))
      .map(row => this.filterPublicListing(row));
  }

  async calculateIndicativeValuation(
    record: LeadCaptureRecord
  ): Promise<IndicativeValuationResult | null> {
    if (!this.config.enabled || record.inquiryPurpose !== 'selling') {
      return null;
    }

    const structuredFields: Record<string, string> = {};
    const add = (key: string, value: string): void => {
      const clean = value.trim();
      if (clean && !/unknown|to confirm/i.test(clean)) {
        structuredFields[key] = clean;
      }
    };

    add('annual_revenue', record.annualRevenueAed);
    add('revenue', record.annualRevenueAed);
    add('net_profit', record.monthlyNetProfitAed);
    add('monthly_operating_expenses', record.monthlyOperatingExpensesAed);
    add('lease', record.leaseDetails);
    add('licenses', record.contractsLicenses);
    add('contracts', record.contractsLicenses);
    add('liabilities', record.liabilities);
    add('included_assets', record.includedAssets);

    const establishedYear = Number.parseInt(record.yearEstablished, 10);
    if (Number.isFinite(establishedYear) && establishedYear >= 1900) {
      const years = Math.max(0, new Date().getUTCFullYear() - establishedYear);
      structuredFields['years'] = String(years);
      structuredFields['year_established'] = String(establishedYear);
    }

    const parsedProfit = this.parseAed(record.monthlyNetProfitAed);
    if (parsedProfit !== null) {
      structuredFields['status'] = parsedProfit > 0 ? 'profitable' : 'active';
    } else {
      structuredFields['status'] = 'active';
    }

    const result = await this.request<{
      valuation?: {
        low?: number;
        mid?: number;
        high?: number;
        currency?: string;
      };
    }>('POST', '/api/v1/valuation/calculate', {
      asset_type: 'business',
      source: 'chat',
      asset_description: record.businessType || 'Business for sale',
      location: record.businessLocation || null,
      urgency: record.saleReasonUrgency || null,
      chat_transcript: [],
      structured_fields: structuredFields,
    });

    const valuation = result.data?.valuation;
    if (
      !result.ok ||
      !valuation ||
      typeof valuation.low !== 'number' ||
      typeof valuation.mid !== 'number' ||
      typeof valuation.high !== 'number'
    ) {
      return null;
    }

    const currency = valuation.currency || 'AED';
    return {
      low: valuation.low,
      mid: valuation.mid,
      high: valuation.high,
      currency,
      formattedRange: `${currency} ${valuation.low.toLocaleString('en-US')}–${valuation.high.toLocaleString('en-US')} (midpoint ${currency} ${valuation.mid.toLocaleString('en-US')})`,
    };
  }

  async getConversationContext(
    externalChatId: string,
    phone: string
  ): Promise<string> {
    if (!this.config.enabled) {
      return '';
    }

    const cacheKey = `${externalChatId}:${phone}`;
    const cached = this.contextCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.value;
    }

    const params = new URLSearchParams({ external_chat_id: externalChatId });
    if (phone) {
      params.set('phone', phone);
    }

    const result = await this.request<unknown>(
      'GET',
      `/api/v1/bot/conversations/context?${params.toString()}`
    );
    if (!result.ok || result.data === undefined) {
      return '';
    }

    const value = this.formatContext(result.data);
    this.contextCache.set(cacheKey, {
      expiresAt: Date.now() + this.config.contextCacheMs,
      value,
    });
    return value;
  }

  async ingestMessage(
    chatId: string,
    direction: 'inbound' | 'outbound',
    message: WhatsAppMessage,
    role: string,
    idempotencyKey: string
  ): Promise<boolean> {
    const result = await this.request<unknown>(
      'POST',
      '/api/v1/bot/messages/ingest',
      {
        external_chat_id: chatId,
        provider: 'whatsapp',
        provider_message_id: message.id,
        direction,
        role,
        from: message.from,
        to: message.to,
        sent_at: new Date(message.timestamp).toISOString(),
        message_type: message.type,
        content: message.content,
        sender_name: message.senderName || null,
        is_group: message.isGroup,
      },
      idempotencyKey
    );
    return result.ok;
  }

  async syncLeadSnapshot(
    record: LeadCaptureRecord,
    idempotencyKey: string
  ): Promise<boolean> {
    if (!this.config.enabled || !record.inquiryPurpose) {
      return true;
    }
    const path =
      record.inquiryPurpose === 'selling'
        ? '/api/v1/bot/seller-intakes/sync'
        : '/api/v1/bot/buyer-enquiries/sync';
    const result = await this.request<unknown>(
      'POST',
      path,
      this.toLeadPayload(record),
      idempotencyKey
    );
    return result.ok;
  }

  async createAccessRequest(
    record: LeadCaptureRecord,
    idempotencyKey: string
  ): Promise<boolean> {
    if (!this.config.enabled || !record.specificListingCode) {
      return false;
    }

    const result = await this.request<unknown>(
      'POST',
      '/api/v1/bot/access-requests',
      {
        external_chat_id: record.chatId,
        source_jid: record.sourceJid,
        client_phone: record.clientPhone || null,
        client_name: record.clientName || null,
        listing_public_code: record.specificListingCode,
        purpose: 'buyer_due_diligence',
        requested_data_classes: ['confidential_listing_details'],
        source: 'whatsapp_bot',
        requested_at: record.timestamp,
      },
      idempotencyKey
    );
    return result.ok;
  }

  async forwardWhatsAppProviderEvent(
    payload: Record<string, unknown>,
    idempotencyKey: string
  ): Promise<boolean> {
    const result = await this.request<unknown>(
      'POST',
      '/api/v1/bot/provider-events/whatsapp',
      payload,
      idempotencyKey
    );
    return result.ok;
  }

  async recordAnalytics(
    eventName: string,
    chatId: string,
    payload: Record<string, unknown>,
    idempotencyKey: string
  ): Promise<boolean> {
    const result = await this.request<unknown>(
      'POST',
      '/api/v1/analytics/events',
      {
        event_name: eventName,
        source: 'whatsapp_bot',
        anonymous_id: chatId,
        occurred_at: new Date().toISOString(),
        properties: payload,
      },
      idempotencyKey
    );
    return result.ok;
  }

  buildIdempotencyKey(...parts: string[]): string {
    return createHash('sha256')
      .update([this.config.botId, ...parts].join(':'))
      .digest('hex');
  }

  private async request<T>(
    method: 'GET' | 'POST',
    path: string,
    body?: Record<string, unknown>,
    idempotencyKey?: string,
    bypassCircuit: boolean = false
  ): Promise<ApiResult<T>> {
    if (!this.config.enabled) {
      return { ok: false, status: 0, error: 'disabled' };
    }
    if (!bypassCircuit && Date.now() < this.failureCooldownUntil) {
      return { ok: false, status: 0, error: 'temporary circuit cooldown' };
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);
    timeout.unref();

    try {
      const headers: Record<string, string> = {
        Accept: 'application/json',
        Authorization: `Bearer ${this.config.serviceToken}`,
        'X-SHARH-Bot-ID': this.config.botId,
      };
      if (body) {
        headers['Content-Type'] = 'application/json';
      }
      if (idempotencyKey) {
        headers['Idempotency-Key'] = idempotencyKey;
      }

      const response = await fetch(`${this.config.baseUrl}${path}`, {
        method,
        headers,
        signal: controller.signal,
        ...(body ? { body: JSON.stringify(body) } : {}),
      });

      const responseText = await response.text();
      let data: T | undefined;
      if (responseText) {
        try {
          data = JSON.parse(responseText) as T;
        } catch {
          data = undefined;
        }
      }

      if (response.ok || response.status === 409) {
        this.markSuccess();
        return {
          ok: true,
          status: response.status,
          ...(data !== undefined ? { data } : {}),
        };
      }

      const error = this.compactError(response.status, responseText);
      const dependencyFailure =
        bypassCircuit ||
        response.status === 408 ||
        response.status === 429 ||
        response.status >= 500;
      if (dependencyFailure) {
        this.markFailure(error);
      } else {
        // A normal application response such as 404 means the API is reachable.
        // It must not make readiness fail or open the network-failure circuit.
        this.markApplicationResponse(error);
      }
      logger.warn('SHARH API request failed', {
        method,
        path: path.split('?')[0],
        status: response.status,
        error,
      });
      return { ok: false, status: response.status, error };
    } catch (error) {
      const message =
        error instanceof Error && error.name === 'AbortError'
          ? `request timed out after ${this.config.timeoutMs}ms`
          : error instanceof Error
            ? error.message
            : 'unknown network error';
      this.markFailure(message);
      logger.warn('SHARH API request could not be completed', {
        method,
        path: path.split('?')[0],
        error: message,
      });
      return { ok: false, status: 0, error: message };
    } finally {
      clearTimeout(timeout);
    }
  }

  private parseAed(value: string): number | null {
    const match = value.match(/([\d,.]+)/);
    if (!match?.[1]) return null;
    const parsed = Number.parseFloat(match[1].replace(/,/g, ''));
    return Number.isFinite(parsed) ? parsed : null;
  }

  private markSuccess(): void {
    this.reachable = true;
    this.lastSuccessAt = new Date().toISOString();
    this.lastError = undefined;
    this.failureCooldownUntil = 0;
  }

  private markFailure(error: string): void {
    this.reachable = false;
    this.lastFailureAt = new Date().toISOString();
    this.lastError = error;
    this.failureCooldownUntil =
      Date.now() + Math.min(30000, Math.max(2000, this.config.timeoutMs));
  }

  private markApplicationResponse(error: string): void {
    this.reachable = true;
    this.lastError = error;
    this.failureCooldownUntil = 0;
  }

  private extractPublicCode(value: string): string | null {
    const match = value.toUpperCase().match(/\bSH-\d{1,12}\b/);
    return match?.[0] || null;
  }

  private extractRows(data: unknown): PublicListingRow[] {
    if (Array.isArray(data)) {
      return data.filter(this.isRecord);
    }
    if (!this.isRecord(data)) {
      return [];
    }

    for (const key of ['items', 'results', 'data']) {
      const candidate = data[key];
      if (Array.isArray(candidate)) {
        return candidate.filter(this.isRecord);
      }
    }

    return [data];
  }

  private filterPublicListing(row: PublicListingRow): PublicListingRow {
    const allowlist = new Set(this.config.publicListingFields);
    return Object.fromEntries(
      Object.entries(row).filter(([key, value]) => {
        if (!allowlist.has(key)) {
          return false;
        }
        return this.isSafePublicValue(value);
      })
    );
  }

  private isSafePublicValue(value: unknown): boolean {
    if (
      value === null ||
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean'
    ) {
      return true;
    }
    return (
      Array.isArray(value) &&
      value.length <= 50 &&
      value.every(
        item =>
          typeof item === 'string' ||
          typeof item === 'number' ||
          typeof item === 'boolean'
      )
    );
  }

  private formatContext(data: unknown): string {
    if (!this.isRecord(data)) {
      return '';
    }

    const safe: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data)) {
      const sanitized = this.sanitizeContextValue(key, value);
      if (sanitized !== undefined) {
        safe[key] = sanitized;
      }
    }

    const serialized = JSON.stringify(safe, null, 2);
    return serialized.length > 6000 ? `${serialized.slice(0, 6000)}\n…` : serialized;
  }

  private sanitizeContextValue(
    key: string,
    value: unknown
  ): unknown | undefined {
    if (this.isBlockedContextKey(key)) {
      return undefined;
    }
    if (
      value === null ||
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean'
    ) {
      return value;
    }
    if (Array.isArray(value)) {
      return value
        .slice(0, 30)
        .map(item => this.sanitizeContextValue(key, item))
        .filter(item => item !== undefined);
    }
    if (this.isRecord(value)) {
      const safe: Record<string, unknown> = {};
      for (const [nestedKey, nestedValue] of Object.entries(value).slice(0, 30)) {
        const sanitized = this.sanitizeContextValue(nestedKey, nestedValue);
        if (sanitized !== undefined) {
          safe[nestedKey] = sanitized;
        }
      }
      return safe;
    }
    return undefined;
  }

  private isBlockedContextKey(key: string): boolean {
    return /(password|secret|token|credential|private|confidential|hidden|document|dataroom|storage|file_path|checksum|competing_buyer)/i.test(
      key
    );
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  }

  private toLeadPayload(record: LeadCaptureRecord): Record<string, unknown> {
    return {
      external_chat_id: record.chatId,
      source_jid: record.sourceJid,
      source: 'whatsapp_bot',
      observed_at: record.timestamp,
      status: record.status,
      funnel_stage: record.funnelStage,
      owner: record.owner,
      escalation_reason: record.escalationReason || null,
      client: {
        name: record.clientName || null,
        phone: record.clientPhone || null,
        language: record.language,
      },
      inquiry_purpose: record.inquiryPurpose || null,
      listing_public_code: record.specificListingCode || null,
      terms_accepted:
        record.termsAccepted === 'yes'
          ? true
          : record.termsAccepted === 'no'
            ? false
            : null,
      qualification: {
        business_type: record.businessType || null,
        business_location: record.businessLocation || null,
        annual_revenue_aed: this.parseAedRepresentative(record.annualRevenueAed),
        lease_details: record.leaseDetails || null,
        desired_selling_price_aed: this.parseAedRepresentative(
          record.desiredSellingPriceAed
        ),
        year_established: this.parseInteger(record.yearEstablished),
        employee_count: this.parseInteger(record.employeeCount),
        monthly_operating_expenses_aed: this.parseAedRepresentative(
          record.monthlyOperatingExpensesAed
        ),
        monthly_net_profit_aed: this.parseAedRepresentative(
          record.monthlyNetProfitAed
        ),
        liabilities: record.liabilities || null,
        contracts_licenses: record.contractsLicenses || null,
        sale_reason_urgency: record.saleReasonUrgency || null,
        included_assets: record.includedAssets || null,
        buyer_budget_aed: this.parseAedUpperBound(record.buyerBudgetAed),
        buyer_location: record.buyerLocation || null,
        buyer_timeline: record.buyerTimeline || null,
        buyer_involvement: record.buyerInvolvement || null,
        buyer_funding_status: record.buyerFundingStatus || null,
        buyer_additional_comments: record.buyerAdditionalComments || null,
        contact_preference: record.contactPreference || null,
      },
      completion_percent: record.completionPercent,
      sales_intelligence: {
        playbook_version: record.playbookVersion,
        score: record.leadScore,
        grade: record.leadGrade,
        temperature: record.leadTemperature,
        score_reasons: record.scoreReasons
          ? record.scoreReasons.split('|').map(value => value.trim()).filter(Boolean)
          : [],
        risk_flags: record.riskFlags
          ? record.riskFlags.split('|').map(value => value.trim()).filter(Boolean)
          : [],
        next_best_action: record.nextBestAction,
        next_best_action_code: record.nextBestActionCode,
        objections_detected: record.objectionsDetected
          ? record.objectionsDetected.split(',').map(value => value.trim()).filter(Boolean)
          : [],
        conversation_summary: record.conversationSummary,
        review_brief: record.reviewBrief,
      },
      next_field: record.nextField || null,
      next_step: record.nextStep || null,
      fields_updated: record.fieldsUpdated
        ? record.fieldsUpdated.split(',').map(value => value.trim()).filter(Boolean)
        : [],
      latest_message: record.latestMessage || null,
      notes: record.notes || null,
    };
  }

  private parseInteger(value: string): number | null {
    const match = value.match(/\d[\d,]*/);
    if (!match) return null;
    const parsed = Number.parseInt(match[0].replace(/,/g, ''), 10);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }

  private parseAedValues(value: string): number[] {
    if (!value || /unknown|to confirm/i.test(value)) return [];
    const matches = value.matchAll(/(?<!\d)(-?\d[\d,.]*)(?:\s*)(k|m|b|thousand|million|billion)?/gi);
    const values: number[] = [];
    for (const match of matches) {
      const raw = match[1];
      if (!raw) continue;
      const normalized = raw.includes(',') && raw.includes('.')
        ? raw.replace(/,/g, '')
        : raw.replace(/,/g, '');
      let parsed = Number.parseFloat(normalized);
      if (!Number.isFinite(parsed)) continue;
      const suffix = (match[2] || '').toLowerCase();
      if (suffix === 'k' || suffix === 'thousand') parsed *= 1_000;
      if (suffix === 'm' || suffix === 'million') parsed *= 1_000_000;
      if (suffix === 'b' || suffix === 'billion') parsed *= 1_000_000_000;
      if (Number.isSafeInteger(Math.round(parsed))) values.push(Math.round(parsed));
    }
    return values;
  }

  private parseAedRepresentative(value: string): number | null {
    const values = this.parseAedValues(value);
    if (values.length === 0) return null;
    if (values.length === 1) return values[0] ?? null;
    return Math.round((Math.min(...values) + Math.max(...values)) / 2);
  }

  private parseAedUpperBound(value: string): number | null {
    const values = this.parseAedValues(value);
    return values.length > 0 ? Math.max(...values) : null;
  }

  private compactError(status: number, responseText: string): string {
    if (!responseText) return `HTTP ${status}`;
    try {
      const parsed = JSON.parse(responseText) as { detail?: unknown };
      const detail = parsed.detail;
      if (typeof detail === 'string' && detail.trim()) {
        return `HTTP ${status}: ${detail.trim().slice(0, 500)}`;
      }
      if (Array.isArray(detail)) {
        const compact = detail
          .slice(0, 5)
          .map(item => {
            if (!item || typeof item !== 'object') return String(item);
            const row = item as Record<string, unknown>;
            const location = Array.isArray(row['loc'])
              ? row['loc'].map(String).join('.')
              : '';
            return `${location}: ${String(row['msg'] || 'invalid value')}`;
          })
          .join('; ');
        if (compact) return `HTTP ${status}: ${compact.slice(0, 500)}`;
      }
    } catch {
      // Keep a bounded plain-text error for non-JSON responses.
    }
    return `HTTP ${status}: ${responseText.replace(/\s+/g, ' ').trim().slice(0, 500)}`;
  }
}
