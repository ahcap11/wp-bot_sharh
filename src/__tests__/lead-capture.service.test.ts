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

  it('creates a review-ready seller lead from one natural details message', () => {
    const chatId = 'seller-minimum';

    const first = turn(chatId, 's1', 'I want to sell my business');
    expect(first.directive.expectedField).toBe('seller_terms');
    expect(first.directive.directResponse).toContain('success-based');

    const accepted = turn(chatId, 's2', '1');
    expect(accepted.directive.expectedField).toBe('business_type');
    expect(accepted.directive.directResponse).toContain('in one message');

    const result = turn(
      chatId,
      's3',
      'Boat trading business in Dubai Marina, annual revenue around 1mln AED and asking AED 600k',
      false
    );

    expect(result.status).toBe('qualified');
    expect(result.directive.directResponse).toContain('initial SHARH review');
    expect(result.directive.directResponse).toContain('Submit for review');

    const record = service.getCurrentRecord(chatId);
    expect(record).toMatchObject({
      inquiryPurpose: 'selling',
      clientPhone: '971501234567',
      businessType: 'Boat trading business',
      businessLocation: 'Dubai Marina',
      annualRevenueAed: 'AED 1,000,000',
      desiredSellingPriceAed: 'AED 600,000',
      status: 'qualified',
      funnelStage: 'ready_for_review',
      owner: 'bot',
      playbookVersion: '1.0.0',
    });
    expect(record?.completionPercent).toBeGreaterThan(0);
  });

  it('asks only for one missing seller financial anchor', () => {
    const chatId = 'seller-missing-finance';
    turn(chatId, 's1', 'sell');
    turn(chatId, 's2', 'yes');
    const result = turn(chatId, 's3', 'A dental clinic in Abu Dhabi');

    expect(result.status).toBe('contacted');
    expect(result.directive.expectedField).toBe('annual_revenue_aed');
    expect(result.directive.directResponse).toContain('One useful figure is enough');
  });

  it('qualifies a buyer after one useful criteria message', () => {
    const chatId = 'buyer-minimum';
    const first = turn(chatId, 'b1', 'I want to buy a business');
    expect(first.directive.expectedField).toBe('business_type');

    const result = turn(chatId, 'b2', 'Salon in Dubai under AED 500k', false);
    expect(result.status).toBe('qualified');
    expect(result.directive.directResponse).toContain('open a result');
    expect(service.getCurrentRecord(chatId)).toMatchObject({
      inquiryPurpose: 'buying',
      businessType: 'Salon',
      buyerLocation: 'Dubai',
      buyerBudgetAed: 'AED 500,000',
      funnelStage: 'ready_for_review',
    });
  });

  it('can start a buyer search with category plus either location or budget', () => {
    const chatId = 'buyer-location-only';
    turn(chatId, 'b1', 'buy');
    const result = turn(chatId, 'b2', 'Healthcare business in Abu Dhabi', false);

    expect(result.status).toBe('qualified');
    expect(service.getCurrentRecord(chatId)).toMatchObject({
      businessType: 'Healthcare business',
      buyerLocation: 'Abu Dhabi',
    });
  });

  it('keeps a specific listing buyer inside the low-friction buyer flow', () => {
    const update = service.updateFromMessage(
      'specific-listing',
      buildMessage('l1', 'I want to buy listing SH-0042. Send me the financials.')
    );
    const directive = service.getDirective('specific-listing');

    expect(update.record).toMatchObject({
      status: 'contacted',
      specificListingCode: 'SH-0042',
      inquiryPurpose: 'buying',
    });
    expect(directive.expectedField).toBe('business_type');
    expect(directive.directResponse).not.toContain('financials');
  });

  it('keeps Russian language while presenting the seller terms first', () => {
    const first = turn('ru-seller', 'r1', 'Я хочу продать бизнес');
    expect(first.directive.directResponse).toContain('Перед началом основные условия');
    expect(first.directive.expectedField).toBe('seller_terms');
    expect(service.getCurrentRecord('ru-seller')?.language).toBe('ru');
  });

  it('handles an objection without storing it as seller consent', () => {
    const chatId = 'seller-objection';
    turn(chatId, 'o1', 'I want to sell my business');
    const objection = turn(chatId, 'o2', 'Why is the commission so high?');

    expect(service.getCurrentRecord(chatId)?.termsAccepted).toBe('');
    expect(service.getCurrentRecord(chatId)?.objectionsDetected).toContain('commission');
    expect(objection.directive.directResponse).toContain('success-based');
    expect(objection.directive.expectedField).toBe('seller_terms');
  });

  it('records a human follow-up request without pausing the bot', () => {
    const chatId = 'human-review';
    service.updateFromMessage(
      chatId,
      buildMessage('h1', 'Please connect me to a live manager now')
    );

    const notice = service.getDirective(chatId);
    expect(notice).toMatchObject({
      owner: 'bot',
      shouldRespond: true,
      expectedField: 'inquiry_purpose',
      markReviewNoticeOnSend: true,
    });
    expect(notice.directResponse).toContain('SHARH review');
    service.confirmDirectiveSent(chatId, notice);
  });

  it('does not advance a question until the outbound message is confirmed sent', () => {
    service.updateFromMessage(
      'send-confirmation',
      buildMessage('c1', 'I want to sell my business')
    );
    const terms = service.getDirective('send-confirmation');
    expect(terms.expectedField).toBe('seller_terms');

    // Simulate an outbound delivery failure: no confirmDirectiveSent call.
    service.updateFromMessage(
      'send-confirmation',
      buildMessage('c2', 'This is a restaurant in Dubai')
    );

    expect(service.getCurrentRecord('send-confirmation')?.termsAccepted).toBe('');
    expect(service.getDirective('send-confirmation').expectedField).toBe('seller_terms');
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
