import { SharhApiService } from '../services/sharh-api.service';
import { SharhApiConfig, WhatsAppMessage } from '../types';

const config = (overrides: Partial<SharhApiConfig> = {}): SharhApiConfig => ({
  enabled: true,
  baseUrl: 'https://sharh.example.com',
  serviceToken: 'service-token',
  timeoutMs: 5000,
  botId: 'whatsapp-funnel',
  allowNeonFallback: false,
  publicListingFields: ['public_code', 'title', 'sector', 'price'],
  syncIntervalMs: 30000,
  syncMaxAttempts: 12,
  syncBatchSize: 20,
  contextCacheMs: 30000,
  ...overrides,
});

const response = (status: number, body: unknown): Response =>
  ({
    ok: status >= 200 && status < 300,
    status,
    text: jest.fn().mockResolvedValue(JSON.stringify(body)),
  }) as unknown as Response;

describe('SharhApiService', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it('uses exact public-code endpoint and removes non-public fields', async () => {
    const fetchMock = jest.fn().mockResolvedValue(
      response(200, {
        public_code: 'SH-0042',
        title: 'Restaurant in Dubai',
        sector: 'F&B',
        seller_phone: '+971500000000',
        confidential_notes: 'do not expose',
      })
    );
    global.fetch = fetchMock as typeof fetch;
    const service = new SharhApiService(config());

    const rows = await service.searchPublicListings('Details for SH-0042');

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      'https://sharh.example.com/api/v1/bot/listings/by-public-code/SH-0042'
    );
    expect(rows).toEqual([
      {
        public_code: 'SH-0042',
        title: 'Restaurant in Dubai',
        sector: 'F&B',
      },
    ]);
  });

  it('sends strict buyer criteria to the server-side matcher', async () => {
    const fetchMock = jest.fn().mockResolvedValue(response(200, { items: [] }));
    global.fetch = fetchMock as typeof fetch;
    const service = new SharhApiService(config());
    const lead = {
      inquiryPurpose: 'buying',
      businessType: 'Any profitable business',
      buyerLocation: '',
      buyerBudgetAed: 'AED 1,000,000',
      buyerMinimumAnnualProfitAed: 'AED 300,000',
      buyerMinimumRoiPct: '',
      buyerInvolvement: 'Passive required',
      buyerAdditionalComments: '',
      buyerReturnPeriod: 'annual',
      buyerExcludedSectors: 'restaurant',
      buyerProfitableOnly: true,
    } as import('../services/lead-capture.service').LeadCaptureRecord;

    await service.searchBuyerMatches(lead, 3);

    const calledUrl = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(calledUrl.pathname).toBe('/api/v1/bot/listings/search');
    expect(calledUrl.searchParams.get('max_price_aed')).toBe('1000000');
    expect(calledUrl.searchParams.get('min_profit_aed')).toBe('300000');
    expect(calledUrl.searchParams.get('profitable_only')).toBe('true');
    expect(calledUrl.searchParams.get('passive_preference')).toBe('required');
    expect(calledUrl.searchParams.getAll('excluded_sector')).toEqual(['restaurant']);
  });

  it('sends service identity and idempotency headers for message ingestion', async () => {
    const fetchMock = jest.fn().mockResolvedValue(response(201, { id: 'm-1' }));
    global.fetch = fetchMock as typeof fetch;
    const service = new SharhApiService(config());
    const message: WhatsAppMessage = {
      id: 'provider-message-1',
      from: '971501234567@s.whatsapp.net',
      to: '971501234567@s.whatsapp.net',
      timestamp: Date.now(),
      type: 'text',
      content: 'I want to sell my business',
      isGroup: false,
    };

    await expect(
      service.ingestMessage(
        message.from,
        'inbound',
        message,
        'sales',
        'idem-1'
      )
    ).resolves.toBe(true);

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect((init.headers as Record<string, string>)['Authorization']).toBe(
      'Bearer service-token'
    );
    expect((init.headers as Record<string, string>)['X-SHARH-Bot-ID']).toBe(
      'whatsapp-funnel'
    );
    expect((init.headers as Record<string, string>)['Idempotency-Key']).toBe(
      'idem-1'
    );
  });




  it('syncs legacy persisted lead snapshots with missing newer buyer fields', async () => {
    const fetchMock = jest.fn().mockResolvedValue(response(200, { ok: true }));
    global.fetch = fetchMock as typeof fetch;
    const service = new SharhApiService(config());

    // Old durable outbox entries predate buyerMinimumRoiPct and several other
    // qualification fields. Runtime deserialization can therefore produce
    // undefined values even though the current TypeScript interface is stricter.
    const legacyRecord = {
      chatId: 'legacy-chat',
      sourceJid: '971501234567@s.whatsapp.net',
      timestamp: new Date().toISOString(),
      inquiryPurpose: 'selling',
      status: 'new',
      funnelStage: 'qualifying',
      owner: 'bot',
      language: 'en',
      businessType: 'Legacy business',
    } as unknown as import('../services/lead-capture.service').LeadCaptureRecord;

    await expect(
      service.syncLeadSnapshot(legacyRecord, 'legacy-idem')
    ).resolves.toBe(true);

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(init.body)) as {
      qualification: Record<string, unknown>;
    };
    expect(body.qualification['buyer_min_roi_pct']).toBeNull();
    expect(body.qualification['buyer_min_annual_profit_aed']).toBeNull();
    expect(body.qualification['year_established']).toBeNull();
    expect(body.qualification['employee_count']).toBeNull();
  });

  it('creates an access request without granting access', async () => {
    const fetchMock = jest.fn().mockResolvedValue(response(201, { id: 'ar-1' }));
    global.fetch = fetchMock as typeof fetch;
    const service = new SharhApiService(config());
    const lead = {
      chatId: 'chat-1',
      sourceJid: '971501234567@s.whatsapp.net',
      clientPhone: '971501234567',
      clientName: 'Buyer',
      specificListingCode: 'SH-0042',
      timestamp: new Date().toISOString(),
    } as import('../services/lead-capture.service').LeadCaptureRecord;

    await expect(
      service.createAccessRequest(lead, 'access-idem')
    ).resolves.toBe(true);

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      'https://sharh.example.com/api/v1/bot/access-requests'
    );
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body['listing_public_code']).toBe('SH-0042');
    expect(body['requested_data_classes']).toEqual([
      'confidential_listing_details',
    ]);
    expect(body).not.toHaveProperty('access_granted');
  });

  it('keeps the API reachable after a valid listing 404', async () => {
    const fetchMock = jest.fn().mockResolvedValue(response(404, { detail: 'not found' }));
    global.fetch = fetchMock as typeof fetch;
    const service = new SharhApiService(config());

    await expect(service.searchPublicListings('SH-9999')).resolves.toEqual([]);
    expect(service.getRuntimeStatus().reachable).toBe(true);
  });

  it('marks a failed health check as unreachable', async () => {
    const fetchMock = jest.fn().mockResolvedValue(response(401, { detail: 'unauthorized' }));
    global.fetch = fetchMock as typeof fetch;
    const service = new SharhApiService(config());

    await expect(service.checkHealth()).resolves.toBe(false);
    expect(service.getRuntimeStatus().reachable).toBe(false);
  });

  it('caches server-filtered conversation context', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValue(
        response(200, {
          contact_id: 'c-1',
          owner: 'bot',
          confidential_notes: 'must not reach model',
        })
      );
    global.fetch = fetchMock as typeof fetch;
    const service = new SharhApiService(config({ contextCacheMs: 60000 }));

    const first = await service.getConversationContext('chat-1', '971501234567');
    const second = await service.getConversationContext('chat-1', '971501234567');

    expect(first).toContain('contact_id');
    expect(first).not.toContain('confidential_notes');
    expect(second).toBe(first);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
