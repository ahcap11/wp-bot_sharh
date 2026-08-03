import { HandoffService } from '../services/handoff.service';
import { LeadCaptureRecord } from '../services/lead-capture.service';
import { ConnectionStatus, MessagingTransport, WhatsAppMessage } from '../types';

const makeTransport = (sendMessage: jest.Mock): MessagingTransport => ({
  initialize: jest.fn().mockResolvedValue(undefined),
  sendMessage,
  onMessage: jest.fn((_handler: (message: WhatsAppMessage) => void) => undefined),
  onConnectionStatusChange: jest.fn(
    (_handler: (status: ConnectionStatus) => void) => undefined
  ),
  getConnectionStatus: jest.fn().mockReturnValue(ConnectionStatus.CONNECTED),
  isConnected: jest.fn().mockReturnValue(true),
  disconnect: jest.fn().mockResolvedValue(undefined),
  getChatParticipants: jest.fn().mockResolvedValue([]),
});

const handoffConfig = (jids: string[]) => ({
  jids,
  retryIntervalMs: 30000,
  maxAttempts: 12,
});

const record = (overrides: Partial<LeadCaptureRecord> = {}): LeadCaptureRecord => ({
  timestamp: new Date().toISOString(),
  chatId: 'lead-chat',
  sourceJid: '971501234567@s.whatsapp.net',
  isGroup: false,
  status: 'qualified_lead',
  funnelStage: 'handoff_pending',
  owner: 'bot',
  escalationReason: 'qualified_lead',
  clientName: 'Sarah Lee',
  clientPhone: '971501234567',
  language: 'en',
  inquiryPurpose: 'selling',
  specificListingCode: '',
  termsAccepted: 'yes',
  annualRevenueAed: 'AED 5,000,000',
  businessType: 'Restaurant chain',
  businessLocation: 'Dubai Marina',
  leaseDetails: 'AED 45,000 monthly; 3 years remaining',
  desiredSellingPriceAed: 'AED 4,200,000',
  yearEstablished: '2018',
  employeeCount: '24',
  monthlyOperatingExpensesAed: 'AED 300,000',
  monthlyNetProfitAed: 'AED 95,000',
  liabilities: 'None',
  contractsLicenses: 'Trade licence',
  saleReasonUrgency: 'Relocation; six months',
  includedAssets: 'Equipment, inventory and brand',
  buyerBudgetAed: '',
  buyerLocation: '',
  buyerTimeline: '',
  buyerInvolvement: '',
  buyerFundingStatus: '',
  buyerAdditionalComments: '',
  completionPercent: 100,
  nextField: '',
  fieldsUpdated: 'included_assets',
  latestMessage: 'Everything is included',
  notes: '',
  ...overrides,
});

describe('HandoffService', () => {
  it('keeps a failed notification retryable and succeeds later', async () => {
    const send = jest
      .fn<Promise<boolean>, [string, string]>()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const service = new HandoffService(
      makeTransport(send),
      handoffConfig(['manager@s.whatsapp.net'])
    );

    const first = await service.notify('lead-chat', record());
    const second = await service.notify('lead-chat', record());

    expect(first.notified).toBe(false);
    expect(second.notified).toBe(true);
    expect(second.accepted).toBe(false);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('deduplicates after the manager notification is accepted by transport', async () => {
    const send = jest.fn<Promise<boolean>, [string, string]>().mockResolvedValue(true);
    const service = new HandoffService(
      makeTransport(send),
      handoffConfig(['manager@s.whatsapp.net'])
    );

    const first = await service.notify('lead-chat', record());
    const second = await service.notify('lead-chat', record());

    expect(first.notified).toBe(true);
    expect(second.notified).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('assigns the first manager whose notification succeeds', async () => {
    const send = jest
      .fn<Promise<boolean>, [string, string]>()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const service = new HandoffService(
      makeTransport(send),
      handoffConfig([
        'manager-1@s.whatsapp.net',
        'manager-2@s.whatsapp.net',
      ])
    );

    const result = await service.notify('lead-chat', record());

    expect(result.notified).toBe(true);
    expect(result.handoff.assignedManagerJid).toBe(
      'manager-2@s.whatsapp.net'
    );
    expect(send.mock.calls[1]?.[1]).toContain('Completion: 100%');
    expect(send.mock.calls[1]?.[1]).toContain('/accept HF-');
  });

  it('requires explicit manager acceptance before human ownership', async () => {
    const send = jest.fn<Promise<boolean>, [string, string]>().mockResolvedValue(true);
    const service = new HandoffService(
      makeTransport(send),
      handoffConfig(['manager@s.whatsapp.net'])
    );
    const notification = await service.notify('lead-chat', record());

    const accepted = await service.executeOperatorCommand(
      'manager@s.whatsapp.net',
      `/accept ${notification.handoff.id}`
    );

    expect(notification.accepted).toBe(false);
    expect(accepted.handled).toBe(true);
    expect(accepted.transition).toBe('accepted');
    expect(accepted.targetChatId).toBe('lead-chat');
  });

  it('supports manager reply and explicit resume', async () => {
    const send = jest.fn<Promise<boolean>, [string, string]>().mockResolvedValue(true);
    const service = new HandoffService(
      makeTransport(send),
      handoffConfig(['manager@s.whatsapp.net'])
    );
    const notification = await service.notify('lead-chat', record());
    await service.executeOperatorCommand(
      'manager@s.whatsapp.net',
      `/accept ${notification.handoff.id}`
    );

    const reply = await service.executeOperatorCommand(
      'manager@s.whatsapp.net',
      `/reply ${notification.handoff.id} I will call you shortly.`
    );
    const released = await service.executeOperatorCommand(
      'manager@s.whatsapp.net',
      `/resume ${notification.handoff.id}`
    );

    expect(reply.reply).toContain('Reply sent');
    expect(released.transition).toBe('released');
    expect(send).toHaveBeenLastCalledWith(
      'lead-chat',
      'I will call you shortly.'
    );
  });

  it('does not notify when no manager recipient is configured', async () => {
    const send = jest.fn<Promise<boolean>, [string, string]>();
    const service = new HandoffService(makeTransport(send), handoffConfig([]));

    const result = await service.notify('lead-chat', record());

    expect(result.notified).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });
});

describe('HandoffService SHARH persistence gate', () => {
  it('does not notify when canonical lead persistence fails', async () => {
    const send = jest.fn<Promise<boolean>, [string, string]>().mockResolvedValue(true);
    const api = {
      isEnabled: jest.fn().mockReturnValue(true),
      buildIdempotencyKey: jest.fn().mockReturnValue('lead-idem'),
      syncLeadSnapshot: jest.fn().mockResolvedValue(false),
      createHandoff: jest.fn().mockResolvedValue(true),
      requiresHandoffPersistence: jest.fn().mockReturnValue(true),
    } as unknown as import('../services/sharh-api.service').SharhApiService;
    const service = new HandoffService(
      makeTransport(send),
      handoffConfig(['manager@s.whatsapp.net']),
      null,
      api
    );

    const result = await service.notify('lead-chat', record());

    expect(result.notified).toBe(false);
    expect(api.syncLeadSnapshot).toHaveBeenCalled();
    expect(api.createHandoff).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('does not notify when required SHARH handoff persistence fails', async () => {
    const send = jest.fn<Promise<boolean>, [string, string]>().mockResolvedValue(true);
    const api = {
      isEnabled: jest.fn().mockReturnValue(true),
      buildIdempotencyKey: jest.fn().mockReturnValue('handoff-idem'),
      syncLeadSnapshot: jest.fn().mockResolvedValue(true),
      createHandoff: jest.fn().mockResolvedValue(false),
      requiresHandoffPersistence: jest.fn().mockReturnValue(true),
    } as unknown as import('../services/sharh-api.service').SharhApiService;
    const service = new HandoffService(
      makeTransport(send),
      handoffConfig(['manager@s.whatsapp.net']),
      null,
      api
    );

    const result = await service.notify('lead-chat', record());

    expect(result.notified).toBe(false);
    expect(api.syncLeadSnapshot).toHaveBeenCalled();
    expect(api.createHandoff).toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });
});
