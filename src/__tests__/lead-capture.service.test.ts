import {
  FunnelDirective,
  LeadCaptureService,
} from '../services/lead-capture.service';
import { WhatsAppMessage } from '../types';

const buildMessage = (
  id: string,
  content: string,
  from: string = '971501234567@s.whatsapp.net'
): WhatsAppMessage => ({
  id,
  from,
  to: from,
  timestamp: Date.now(),
  type: 'text',
  content,
  isGroup: false,
  isFromBot: false,
});

interface TurnResult {
  directive: FunnelDirective;
  status: string;
  nextField: string;
}

describe('LeadCaptureService', () => {
  let service: LeadCaptureService;

  beforeEach(() => {
    service = new LeadCaptureService();
  });

  const turn = (
    chatId: string,
    id: string,
    content: string,
    confirmOutbound: boolean = true
  ): TurnResult => {
    service.updateFromMessage(chatId, buildMessage(id, content));
    const directive = service.getDirective(chatId);
    if (confirmOutbound && directive.shouldRespond) {
      service.confirmDirectiveSent(chatId, directive);
    }
    const record = service.getCurrentRecord(chatId);
    return {
      directive,
      status: record?.status || '',
      nextField: record?.nextField || '',
    };
  };

  it('runs a seller through every required qualification field before handoff', () => {
    const chatId = 'seller-complete';

    expect(turn(chatId, 's1', 'I want to sell my business').directive.expectedField)
      .toBe('client_name');
    expect(turn(chatId, 's2', 'My name is Sarah Lee').directive.expectedField)
      .toBe('seller_terms');
    expect(turn(chatId, 's3', 'Yes, I agree').directive.expectedField)
      .toBe('business_type');

    const answers: Array<[string, string, string]> = [
      ['s4', 'We operate a vegan restaurant chain', 'business_location'],
      ['s5', 'Dubai Marina', 'annual_revenue_aed'],
      ['s6', 'AED 5,000,000', 'lease_details'],
      ['s7', 'Leased for AED 45,000 monthly, 3 years remaining', 'desired_selling_price_aed'],
      ['s8', 'AED 4,200,000', 'year_established'],
      ['s9', '2018', 'employee_count'],
      ['s10', '24', 'monthly_operating_expenses_aed'],
      ['s11', 'AED 300,000', 'monthly_net_profit_aed'],
      ['s12', 'AED 95,000', 'liabilities'],
      ['s13', 'No debt', 'contracts_licenses'],
      ['s14', 'Trade licence and two supplier agreements', 'sale_reason_urgency'],
      ['s15', 'Owner relocation; target completion within six months', 'included_assets'],
    ];

    for (const [id, answer, expectedNext] of answers) {
      const result = turn(chatId, id, answer);
      expect(result.status).toBe('collecting');
      expect(result.directive.expectedField).toBe(expectedNext);
    }

    const final = turn(
      chatId,
      's16',
      'Equipment, inventory, brand, licences and social accounts',
      false
    );

    expect(final.status).toBe('qualified_lead');
    expect(final.directive.requiresHandoff).toBe(true);

    const record = service.getCurrentRecord(chatId);
    expect(record).toMatchObject({
      inquiryPurpose: 'selling',
      clientName: 'Sarah Lee',
      clientPhone: '971501234567',
      businessLocation: 'Dubai Marina',
      annualRevenueAed: 'AED 5,000,000',
      desiredSellingPriceAed: 'AED 4,200,000',
      completionPercent: 100,
      funnelStage: 'handoff_pending',
      owner: 'bot',
    });
  });

  it('does not qualify a buyer after only sector and budget', () => {
    const chatId = 'buyer-incomplete';
    turn(chatId, 'b1', 'I want to buy a business');
    turn(chatId, 'b2', 'John Carter');
    turn(chatId, 'b3', 'Healthcare');
    const result = turn(chatId, 'b4', 'AED 3 million');

    expect(result.status).toBe('collecting');
    expect(result.directive.expectedField).toBe('buyer_location');
    expect(service.getCurrentRecord(chatId)?.completionPercent).toBeLessThan(100);
  });

  it('qualifies a buyer only after the complete buyer mandate is captured', () => {
    const chatId = 'buyer-complete';
    turn(chatId, 'b1', 'I am looking to acquire a business');
    turn(chatId, 'b2', 'John Carter');
    turn(chatId, 'b3', 'Healthcare and pharmacies');
    turn(chatId, 'b4', 'AED 3-5 million');
    turn(chatId, 'b5', 'Dubai or Abu Dhabi');
    turn(chatId, 'b6', 'Within four months');
    turn(chatId, 'b7', 'I want to operate it personally');
    turn(chatId, 'b8', 'Funds are available now');
    const result = turn(
      chatId,
      'b9',
      'Prefer an established team and no major liabilities',
      false
    );

    expect(result.status).toBe('qualified_lead');
    expect(result.directive.requiresHandoff).toBe(true);
    expect(service.getCurrentRecord(chatId)).toMatchObject({
      inquiryPurpose: 'buying',
      buyerBudgetAed: 'AED 3,000,000–5,000,000',
      buyerLocation: 'Dubai or Abu Dhabi',
      completionPercent: 100,
    });
  });

  it('escalates a specific listing request without exposing listing data', () => {
    const update = service.updateFromMessage(
      'specific-listing',
      buildMessage('l1', 'I want to buy listing SH-0042. Send me the financials.')
    );
    const directive = service.getDirective('specific-listing');

    expect(update.record).toMatchObject({
      status: 'early_escalation',
      specificListingCode: 'SH-0042',
      inquiryPurpose: 'buying',
    });
    expect(update.record?.notes).toContain('SH-0042');
    expect(directive.requiresHandoff).toBe(true);
  });

  it('keeps Russian language and asks deterministic Russian questions', () => {
    const first = turn('ru-seller', 'r1', 'Я хочу продать бизнес');
    expect(first.directive.directResponse).toContain('Как я могу к вам обращаться');

    const second = turn('ru-seller', 'r2', 'Меня зовут Алексей Иванов');
    expect(second.directive.directResponse).toContain('конфиденциально');
    expect(service.getCurrentRecord('ru-seller')?.language).toBe('ru');
  });

  it('changes ownership only after a successful handoff and then suppresses the bot', () => {
    const chatId = 'human-owned';
    service.updateFromMessage(
      chatId,
      buildMessage('h1', 'Please connect me to a live manager now')
    );

    expect(service.getDirective(chatId).requiresHandoff).toBe(true);
    service.markHandoffCompleted(chatId);

    const closing = service.getDirective(chatId);
    expect(closing.owner).toBe('human');
    expect(closing.shouldRespond).toBe(true);
    service.confirmDirectiveSent(chatId, closing);

    const suppressed = service.getDirective(chatId);
    expect(suppressed).toMatchObject({
      owner: 'human',
      stage: 'human_owned',
      shouldRespond: false,
      requiresHandoff: false,
    });
  });

  it('does not advance the expected field until the outbound question is confirmed sent', () => {
    service.updateFromMessage(
      'send-confirmation',
      buildMessage('c1', 'I want to sell my business')
    );
    const askName = service.getDirective('send-confirmation');
    expect(askName.expectedField).toBe('client_name');

    // Simulate an outbound delivery failure: no confirmDirectiveSent call.
    service.updateFromMessage(
      'send-confirmation',
      buildMessage('c2', 'This is a restaurant in Dubai')
    );

    expect(service.getCurrentRecord('send-confirmation')?.clientName).toBe('');
    expect(service.getDirective('send-confirmation').expectedField).toBe('client_name');
  });

  it('ignores duplicate provider message ids', () => {
    const first = service.updateFromMessage(
      'duplicate',
      buildMessage('same-id', 'My name is Sam')
    );
    const duplicate = service.updateFromMessage(
      'duplicate',
      buildMessage('same-id', 'My name is Different')
    );

    expect(first.shouldPersist).toBe(true);
    expect(duplicate.shouldPersist).toBe(false);
    expect(service.getCurrentRecord('duplicate')?.clientName).toBe('Sam');
  });
});
