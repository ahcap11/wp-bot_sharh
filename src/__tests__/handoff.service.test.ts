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
  it('does not mark a failed handoff as delivered and retries later', async () => {
    const send = jest
      .fn<Promise<boolean>, [string, string]>()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const service = new HandoffService(makeTransport(send), {
      jids: ['manager@s.whatsapp.net'],
    });

    await expect(service.notify('lead-chat', record())).resolves.toBe(false);
    await expect(service.notify('lead-chat', record())).resolves.toBe(true);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('deduplicates only after successful delivery', async () => {
    const send = jest.fn<Promise<boolean>, [string, string]>().mockResolvedValue(true);
    const service = new HandoffService(makeTransport(send), {
      jids: ['manager@s.whatsapp.net'],
    });

    await expect(service.notify('lead-chat', record())).resolves.toBe(true);
    await expect(service.notify('lead-chat', record())).resolves.toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('succeeds when at least one configured manager receives the handoff', async () => {
    const send = jest
      .fn<Promise<boolean>, [string, string]>()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const service = new HandoffService(makeTransport(send), {
      jids: ['manager-1@s.whatsapp.net', 'manager-2@s.whatsapp.net'],
    });

    await expect(service.notify('lead-chat', record())).resolves.toBe(true);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1]?.[1]).toContain('Completion: 100%');
    expect(send.mock.calls[1]?.[1]).toContain('Monthly net profit: AED 95,000');
  });

  it('returns false when no manager recipient is configured', async () => {
    const send = jest.fn<Promise<boolean>, [string, string]>();
    const service = new HandoffService(makeTransport(send), { jids: [] });

    await expect(service.notify('lead-chat', record())).resolves.toBe(false);
    expect(send).not.toHaveBeenCalled();
  });
});
