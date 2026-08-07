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

  it('requires a budget before running a generic buyer search', () => {
    const chatId = 'buyer-location-only';
    turn(chatId, 'b1', 'buy');
    const result = turn(chatId, 'b2', 'Healthcare business in Abu Dhabi', false);

    expect(result.status).toBe('contacted');
    expect(result.directive.expectedField).toBe('buyer_budget_aed');
    expect(service.getCurrentRecord(chatId)).toMatchObject({
      businessType: 'Healthcare business',
      buyerLocation: 'Abu Dhabi',
    });
  });

  it('captures strict buyer economics from the screenshot request on the first turn', () => {
    const chatId = 'buyer-strict-return';
    turn(
      chatId,
      'b1',
      'I am looking for cash generating business, my budget is 1M aed, if it brings more than 300K passively it is good for me',
      false
    );

    const record = service.getCurrentRecord(chatId);
    expect(record).toMatchObject({
      inquiryPurpose: 'buying',
      businessType: 'Any profitable business',
      buyerBudgetAed: 'AED 1,000,000',
      buyerInvolvement: 'Passive required',
      buyerReturnPeriod: 'ambiguous',
      buyerMinimumAnnualProfitAed: '',
      buyerProfitableOnly: true,
      desiredSellingPriceAed: '',
    });
  });

  it('answers a buyer side question without repeating the full buyer prompt', () => {
    const chatId = 'buyer-no-repeat-side-question';
    const first = turn(chatId, 'b1', 'buy');
    expect(first.directive.directResponse).toContain('Describe the business you want');

    const fee = turn(chatId, 'b2', 'what is your commission?', false);
    expect(fee.directive.directResponse).toContain('success-based only');
    expect(fee.directive.directResponse).not.toContain('Describe the business you want');
  });

  it('uses a focused retry instead of repeating the full buyer questionnaire', () => {
    const chatId = 'buyer-focused-retry';
    turn(chatId, 'b1', 'buy');
    const retry = turn(chatId, 'b2', 'nonsense', false);

    expect(retry.directive.directResponse).toContain('sector');
    expect(retry.directive.directResponse).not.toContain('maximum budget');
    expect(retry.directive.directResponse).not.toContain('minimum annual profit');
  });

  it('accepts an unlabelled budget after any sector', () => {
    const chatId = 'buyer-compact-budget';
    turn(chatId, 'b1', 'buy');
    const result = turn(chatId, 'b2', 'any sector 10000000', false);

    expect(result.status).toBe('qualified');
    expect(service.getCurrentRecord(chatId)).toMatchObject({
      businessType: 'Any profitable business',
      buyerBudgetAed: 'AED 10,000,000',
      objectionsDetected: '',
    });
    expect(result.directive.directResponse).not.toContain('success-based only');
  });

  it('updates saved buyer profit and budget criteria after qualification', () => {
    const chatId = 'buyer-refinement-after-qualified';
    turn(chatId, 'b1', 'buy');
    turn(chatId, 'b2', 'any sector 10000000 100000 passive', false);

    turn(chatId, 'b3', 'annual profit 250K', false);
    expect(service.getCurrentRecord(chatId)).toMatchObject({
      buyerBudgetAed: 'AED 10,000,000',
      buyerMinimumAnnualProfitAed: 'AED 250,000',
      buyerReturnPeriod: 'annual',
      buyerInvolvement: 'Passive required',
    });

    turn(chatId, 'b4', 'budget 1.5M', false);
    expect(service.getCurrentRecord(chatId)).toMatchObject({
      buyerBudgetAed: 'AED 1,500,000',
      buyerMinimumAnnualProfitAed: 'AED 250,000',
      buyerInvolvement: 'Passive required',
    });
  });

  it('accepts the compact buyer reply shown in WhatsApp without misreading money as commission', () => {
    const chatId = 'buyer-compact-numbers';
    turn(chatId, 'b1', 'buy');

    const result = turn(
      chatId,
      'b2',
      'any sector 10000000 100000 passive',
      false
    );

    expect(result.status).toBe('qualified');
    expect(service.getCurrentRecord(chatId)).toMatchObject({
      inquiryPurpose: 'buying',
      businessType: 'Any profitable business',
      buyerBudgetAed: 'AED 10,000,000',
      buyerMinimumAnnualProfitAed: 'AED 100,000',
      buyerReturnPeriod: 'annual',
      buyerInvolvement: 'Passive required',
      buyerProfitableOnly: true,
      objectionsDetected: '',
    });
    expect(result.directive.directResponse).not.toContain('success-based only');
  });

  it('accepts compact sector, budget, location, profit and passive criteria', () => {
    const chatId = 'buyer-compact-specific';
    turn(chatId, 'b1', 'buy');
    turn(chatId, 'b2', 'restaurant 1000000 Dubai 200000 passive', false);

    expect(service.getCurrentRecord(chatId)).toMatchObject({
      businessType: 'Restaurant',
      buyerBudgetAed: 'AED 1,000,000',
      buyerLocation: 'Dubai',
      buyerMinimumAnnualProfitAed: 'AED 200,000',
      buyerReturnPeriod: 'annual',
      buyerInvolvement: 'Passive required',
    });
  });

  it('accepts a compact ROI slot without treating 5 percent as a fee question', () => {
    const chatId = 'buyer-compact-roi';
    turn(chatId, 'b1', 'buy');
    turn(chatId, 'b2', 'any sector 10m 5% passive', false);

    expect(service.getCurrentRecord(chatId)).toMatchObject({
      businessType: 'Any profitable business',
      buyerBudgetAed: 'AED 10,000,000',
      buyerMinimumRoiPct: '5%',
      buyerInvolvement: 'Passive required',
      objectionsDetected: '',
    });
  });

  it('resolves annual return clarification and supports later criteria changes', () => {
    const chatId = 'buyer-criteria-correction';
    turn(chatId, 'b1', 'buy');
    turn(
      chatId,
      'b2',
      'Any profitable business, budget AED 1,000,000, profit above AED 300,000, passive',
      false
    );
    turn(chatId, 'b3', 'Annual. Exclude restaurants and gyms.', false);

    expect(service.getCurrentRecord(chatId)).toMatchObject({
      buyerMinimumAnnualProfitAed: 'AED 300,000',
      buyerReturnPeriod: 'annual',
      buyerInvolvement: 'Passive required',
      buyerExcludedSectors: 'restaurants, gyms',
    });

    turn(chatId, 'b4', 'Budget 1.5M and active management is acceptable', false);
    expect(service.getCurrentRecord(chatId)).toMatchObject({
      buyerBudgetAed: 'AED 1,500,000',
      buyerInvolvement: 'Open to either',
    });
  });

  it('keeps an any-sector flexible-budget request generic across sentences', () => {
    const chatId = 'buyer-flexible-generic';
    turn(
      chatId,
      'b1',
      'I want to buy any profitable business. My budget is flexible, active management is acceptable.',
      false
    );

    expect(service.getCurrentRecord(chatId)).toMatchObject({
      inquiryPurpose: 'buying',
      businessType: 'Any profitable business',
      buyerBudgetAed: 'Flexible / no fixed maximum',
      buyerInvolvement: 'Open to either',
      buyerProfitableOnly: true,
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

  it('parses natural buyer ranges, monthly income and hands-off intent without inventing a sector', () => {
    const chatId = 'buyer-natural-range-monthly';
    turn(chatId, 'b1', 'buy');
    turn(
      chatId,
      'b2',
      "I can spend between 1 and 2 million, want 25k per month, don't want to run it",
      false
    );

    expect(service.getCurrentRecord(chatId)).toMatchObject({
      businessType: 'Any profitable business',
      buyerSectorPreference: 'any',
      buyerBudgetAed: 'AED 2,000,000',
      buyerMinimumAnnualProfitAed: 'AED 300,000',
      buyerReturnPeriod: 'monthly',
      buyerInvolvement: 'Passive required',
    });
  });

  it('handles dot-grouped money and p.m. correctly', () => {
    const chatId = 'buyer-dot-grouped-monthly';
    turn(chatId, 'b1', 'buy');
    turn(chatId, 'b2', 'budget 1.000.000, profit 20k p.m.', false);

    expect(service.getCurrentRecord(chatId)).toMatchObject({
      businessType: 'Any profitable business',
      buyerBudgetAed: 'AED 1,000,000',
      buyerMinimumAnnualProfitAed: 'AED 240,000',
      buyerReturnPeriod: 'monthly',
    });
  });

  it('understands word money, grand and manager-run intent', () => {
    const chatId = 'buyer-word-money';
    turn(chatId, 'b1', 'buy');
    turn(
      chatId,
      'b2',
      'two million budget, nets me 300 grand a year, someone else runs it',
      false
    );

    expect(service.getCurrentRecord(chatId)).toMatchObject({
      businessType: 'Any profitable business',
      buyerBudgetAed: 'AED 2,000,000',
      buyerMinimumAnnualProfitAed: 'AED 300,000',
      buyerReturnPeriod: 'annual',
      buyerInvolvement: 'Passive required',
    });
  });

  it('distinguishes required sector/location from preferences', () => {
    const chatId = 'buyer-hard-soft';
    turn(chatId, 'b1', 'buy');
    turn(
      chatId,
      'b2',
      'restaurants only, max 1.5 mil, Dubai only, ROI 20 percent, passive preferred',
      false
    );

    expect(service.getCurrentRecord(chatId)).toMatchObject({
      businessType: 'Restaurants',
      buyerSectorPreference: 'required',
      buyerBudgetAed: 'AED 1,500,000',
      buyerLocation: 'Dubai',
      buyerLocationPreference: 'required',
      buyerMinimumRoiPct: '20%',
      buyerInvolvement: 'Passive preferred',
    });
  });

  it('asks what a bare refinement amount means instead of overwriting saved economics', () => {
    const chatId = 'buyer-bare-refinement';
    turn(chatId, 'b1', 'buy');
    turn(chatId, 'b2', 'any sector 10m 100k passive', false);
    const ambiguous = turn(chatId, 'b3', '250k', false);

    expect(ambiguous.directive.directResponse).toContain('budget or minimum annual profit');
    expect(service.getCurrentRecord(chatId)).toMatchObject({
      buyerBudgetAed: 'AED 10,000,000',
      buyerMinimumAnnualProfitAed: 'AED 100,000',
    });

    turn(chatId, 'b4', 'budget', false);
    expect(service.getCurrentRecord(chatId)).toMatchObject({
      buyerBudgetAed: 'AED 250,000',
      buyerMinimumAnnualProfitAed: 'AED 100,000',
    });
  });

  it('never silently relabels a non-AED buyer budget as AED', () => {
    const chatId = 'buyer-foreign-currency';
    turn(chatId, 'b1', 'buy');
    const result = turn(chatId, 'b2', '$1m budget', false);

    expect(service.getCurrentRecord(chatId)?.buyerBudgetAed).toBe('');
    expect(result.directive.directResponse).toContain('amount in USD');
    expect(result.directive.directResponse).toContain('AED');
  });

  it('supports exclusions and later removes an exclusion naturally', () => {
    const chatId = 'buyer-exclusion-correction';
    turn(chatId, 'b1', 'buy');
    turn(chatId, 'b2', 'anything except restaurants and gyms under 2m', false);
    expect(service.getCurrentRecord(chatId)?.buyerExcludedSectors).toBe('restaurants, gyms');

    turn(chatId, 'b3', 'restaurants are fine now', false);
    expect(service.getCurrentRecord(chatId)?.buyerExcludedSectors).toBe('gyms');
  });

  it('does not mistake operational negatives or no-sector preference for excluded sectors', () => {
    const chatId = 'buyer-negative-language';
    turn(chatId, 'b1', 'buy');
    turn(
      chatId,
      'b2',
      'no sector preference, budget 1.5m, income 300k p.a., manager in place',
      false
    );

    expect(service.getCurrentRecord(chatId)).toMatchObject({
      businessType: 'Any profitable business',
      buyerSectorPreference: 'any',
      buyerExcludedSectors: '',
      buyerBudgetAed: 'AED 1,500,000',
      buyerMinimumAnnualProfitAed: 'AED 300,000',
      buyerInvolvement: 'Passive required',
    });
  });

  it('keeps word-money values in source order for compact buyer tuples', () => {
    const chatId = 'buyer-word-money-order';
    turn(chatId, 'b1', 'buy');
    turn(chatId, 'b2', 'any sector one and a half million 250k passive', false);

    expect(service.getCurrentRecord(chatId)).toMatchObject({
      businessType: 'Any profitable business',
      buyerSectorPreference: 'any',
      buyerBudgetAed: 'AED 1,500,000',
      buyerMinimumAnnualProfitAed: 'AED 250,000',
      buyerReturnPeriod: 'annual',
      buyerInvolvement: 'Passive required',
    });
  });

  it.each(['make it 250k', 'lower it to 250k', 'set it at 250k'])(
    'clarifies ambiguous post-profile refinement: %s',
    phrase => {
      const chatId = `buyer-ambiguous-refinement-${phrase.replace(/\W+/g, '-')}`;
      turn(chatId, 'b1', 'buy');
      turn(chatId, 'b2', 'any sector 10m 100k passive', false);
      const result = turn(chatId, 'b3', phrase, false);

      expect(result.directive.directResponse).toContain('budget or minimum annual profit');
      expect(service.getCurrentRecord(chatId)).toMatchObject({
        buyerBudgetAed: 'AED 10,000,000',
        buyerMinimumAnnualProfitAed: 'AED 100,000',
      });
    }
  );

  it('treats an unlabeled money range as one budget range, not budget plus profit', () => {
    const chatId = 'buyer-budget-range';
    turn(chatId, 'b1', 'buy');
    turn(chatId, 'b2', 'any sector 500k-1m passive', false);

    expect(service.getCurrentRecord(chatId)).toMatchObject({
      businessType: 'Any profitable business',
      buyerBudgetAed: 'AED 1,000,000',
      buyerMinimumAnnualProfitAed: '',
      buyerInvolvement: 'Passive required',
    });
  });

  it('uses the corrected values when the buyer changes figures inside the same message', () => {
    const chatId = 'buyer-same-message-correction';
    turn(chatId, 'b1', 'buy');
    turn(
      chatId,
      'b2',
      'budget 2m actually 1.5m, profit 200k actually 300k a year',
      false
    );

    expect(service.getCurrentRecord(chatId)).toMatchObject({
      buyerBudgetAed: 'AED 1,500,000',
      buyerMinimumAnnualProfitAed: 'AED 300,000',
      buyerReturnPeriod: 'annual',
    });
  });

  it('understands common buyer typos without weakening financial validation', () => {
    const chatId = 'buyer-common-typos';
    turn(chatId, 'b1', 'buy');
    turn(chatId, 'b2', 'budjet 2 milion, proffit 20k montly, pasive', false);

    expect(service.getCurrentRecord(chatId)).toMatchObject({
      buyerBudgetAed: 'AED 2,000,000',
      buyerMinimumAnnualProfitAed: 'AED 240,000',
      buyerInvolvement: 'Passive required',
    });
  });

  it('normalizes Russian compact money units and Arabic-Indic digits', () => {
    const russianChat = 'buyer-russian-money';
    turn(russianChat, 'r1', 'buy');
    turn(russianChat, 'r2', 'бюджет 2 млн, прибыль 300 тыс в год', false);
    expect(service.getCurrentRecord(russianChat)).toMatchObject({
      buyerBudgetAed: 'AED 2,000,000',
      buyerMinimumAnnualProfitAed: 'AED 300,000',
    });

    const arabicChat = 'buyer-arabic-digits';
    turn(arabicChat, 'a1', 'buy');
    turn(arabicChat, 'a2', 'الميزانية ٢ مليون، الربح ٣٠٠ ألف سنوي', false);
    expect(service.getCurrentRecord(arabicChat)).toMatchObject({
      buyerBudgetAed: 'AED 2,000,000',
      buyerMinimumAnnualProfitAed: 'AED 300,000',
    });
  });

  it('normalizes weekly and quarterly earnings into an annual minimum', () => {
    const weeklyChat = 'buyer-weekly-profit';
    turn(weeklyChat, 'w1', 'buy');
    turn(weeklyChat, 'w2', 'budget 2m, profit 10k per week', false);
    expect(service.getCurrentRecord(weeklyChat)).toMatchObject({
      buyerBudgetAed: 'AED 2,000,000',
      buyerMinimumAnnualProfitAed: 'AED 520,000',
      buyerReturnPeriod: 'annual',
    });

    const quarterlyChat = 'buyer-quarterly-profit';
    turn(quarterlyChat, 'q1', 'buy');
    turn(quarterlyChat, 'q2', 'budget 2m, 100k per quarter', false);
    expect(service.getCurrentRecord(quarterlyChat)).toMatchObject({
      buyerBudgetAed: 'AED 2,000,000',
      buyerMinimumAnnualProfitAed: 'AED 400,000',
      buyerReturnPeriod: 'annual',
    });
  });

  it('keeps passive as a preference when the buyer says if possible', () => {
    const chatId = 'buyer-passive-soft';
    turn(chatId, 'b1', 'buy');
    turn(chatId, 'b2', 'unlimited budget, any sector, passive if possible', false);

    expect(service.getCurrentRecord(chatId)).toMatchObject({
      businessType: 'Any profitable business',
      buyerBudgetAed: 'Flexible / no fixed maximum',
      buyerInvolvement: 'Passive preferred',
    });
  });

  it('recognizes hard sector/location phrased as a must', () => {
    const chatId = 'buyer-hard-must';
    turn(chatId, 'b1', 'buy');
    turn(chatId, 'b2', 'restaurant is a must, Dubai is a must, budget 2m, ROI 15', false);

    expect(service.getCurrentRecord(chatId)).toMatchObject({
      businessType: 'Restaurant',
      buyerSectorPreference: 'required',
      buyerLocation: 'Dubai',
      buyerLocationPreference: 'required',
      buyerBudgetAed: 'AED 2,000,000',
      buyerMinimumRoiPct: '15%',
    });
  });

  it('honors same-message sector and location corrections', () => {
    const sectorChat = 'buyer-sector-correction';
    turn(sectorChat, 's1', 'buy');
    turn(sectorChat, 's2', 'restaurant, actually salon, budget 1m', false);
    expect(service.getCurrentRecord(sectorChat)?.businessType).toBe('Salon');

    const locationChat = 'buyer-location-correction';
    turn(locationChat, 'l1', 'buy');
    turn(locationChat, 'l2', 'Dubai, actually Abu Dhabi, budget 1m any sector', false);
    expect(service.getCurrentRecord(locationChat)?.buyerLocation).toBe('Abu Dhabi');
  });

});
