import { LeadCaptureService } from '../services/lead-capture.service';
import type { WhatsAppMessage } from '../types';

const message = (id: string, content: string): WhatsAppMessage => ({
  id,
  from: '971500000001@s.whatsapp.net',
  to: 'bot@s.whatsapp.net',
  timestamp: Date.now(),
  type: 'text',
  content,
  isGroup: false,
  isFromBot: false,
});

describe('conversation navigation and seller terms', () => {
  let service: LeadCaptureService;
  let sequence: number;
  const chatId = 'navigation-chat';

  const turn = (content: string): void => {
    service.updateFromMessage(chatId, message(`m-${++sequence}`, content));
    const directive = service.getDirective(chatId);
    if (directive.shouldRespond) service.confirmDirectiveSent(chatId, directive);
  };

  beforeEach(() => {
    service = new LeadCaptureService();
    sequence = 0;
  });

  it('presents centralized success-fee wording before seller intake', () => {
    service.updateFromMessage(chatId, message(`m-${++sequence}`, 'I want to sell'));
    const terms = service.getDirective(chatId).directResponse || '';
    expect(terms).toContain('5% for deals above USD 200,000');
    expect(terms).toContain('flat USD 10,000');
    expect(terms).not.toContain('2%');
  });

  it('asks which part needs clarification when the seller rejects the terms', () => {
    turn('sell');
    turn('no');

    expect(service.getDirective(chatId).directResponse).toContain('Which part of the terms');
    expect(service.getCurrentRecord(chatId)?.termsAccepted).toBe('no');
  });

  it('supports language switching, review, changing, pause and resume without AI', () => {
    turn('buy');
    turn('Healthcare business in Dubai under AED 2 million');

    const language = service.handleNavigationCommand(chatId, 'Speak English');
    expect(language.response).toContain('continue in English');

    const review = service.handleNavigationCommand(chatId, 'review my answers');
    expect(review.handled).toBe(true);
    expect(review.response).toContain('Healthcare business');
    expect(review.response).toContain('Dubai');

    const directChange = service.handleNavigationCommand(chatId, 'change location to Abu Dhabi');
    expect(directChange.response).toContain('Updated');
    expect(service.getCurrentRecord(chatId)?.buyerLocation).toBe('Abu Dhabi');

    const paused = service.handleNavigationCommand(chatId, 'pause');
    expect(paused.response).toContain('progress is saved');
    expect(service.getDirective(chatId).shouldRespond).toBe(false);

    const resumed = service.handleNavigationCommand(chatId, 'resume');
    expect(resumed.response).toContain('Continuing');
  });

  it('requires confirmation before starting over and clears only active answers', () => {
    turn('sell');
    turn('yes');
    turn('Restaurant in Dubai, expected price AED 600k');

    const request = service.handleNavigationCommand(chatId, 'start over');
    expect(request.response).toContain('Should I start over');
    expect(service.getCurrentRecord(chatId)?.businessType).toBe('Restaurant');

    const confirmed = service.handleNavigationCommand(chatId, '1');
    expect(confirmed.resetAiUsage).toBe(true);
    expect(service.getCurrentRecord(chatId)?.businessType).toBe('');
    expect(service.getDirective(chatId).expectedField).toBe('inquiry_purpose');
  });

  it('recognizes a common start-over typo and marks confirmed restart for backend release', () => {
    turn('sell');
    turn('yes');
    turn('Restaurant in Dubai, expected price AED 600k');

    const request = service.handleNavigationCommand(chatId, 'Start pver');
    expect(request.response).toContain('Should I start over');
    expect(service.isRestartRecoveryCommand(chatId, 'Yes')).toBe(true);

    const confirmed = service.handleNavigationCommand(chatId, 'Yes');
    expect(confirmed.restartConfirmed).toBe(true);
    expect(confirmed.response).toContain('Started over');
    expect(confirmed.response).toContain('buy or sell');
  });

  it('switches between buyer and seller routes without a new chat', () => {
    turn('buy');
    turn('Healthcare in Dubai');

    const switched = service.handleNavigationCommand(chatId, 'switch to selling');
    expect(switched.response).toContain('switched this request to selling');
    expect(service.getCurrentRecord(chatId)?.inquiryPurpose).toBe('selling');
    expect(service.getDirective(chatId).expectedField).toBe('seller_terms');
  });

  it('keeps seller choices to submit, optional details, or website', () => {
    turn('sell');
    turn('yes');
    turn('Restaurant in Dubai, expected selling price AED 600k');

    const ready = service.getDirective(chatId).directResponse || '';
    expect(ready).toContain('submit it for review');
    expect(ready).toContain('add more details');
    expect(ready).toContain('website link');
    expect(ready).not.toContain('contact me');

    const details = service.handleNavigationCommand(chatId, 'add more details');
    expect(details.response).toContain('additional details in one message');

    service.updateFromMessage(chatId, message(`m-${++sequence}`, '10 employees, no debt, monthly profit AED 30k'));
    const website = service.handleNavigationCommand(chatId, 'continue on website');
    expect(website.response).toContain('/sell/intake');
  });

  it('requires business, location, and expected selling price but keeps revenue optional', () => {
    turn('sell');
    turn('yes');
    turn('Boat trading company in Dubai, expected selling price around AED 600k');

    const record = service.getCurrentRecord(chatId);
    expect(record?.status).toBe('qualified');
    expect(record?.businessType).toContain('Boat');
    expect(record?.businessLocation).toContain('Dubai');
    expect(record?.desiredSellingPriceAed).toContain('600,000');
    expect(record?.annualRevenueAed).toBe('');
  });

  it('parses a USD seller price range and still returns the review-ready reply', () => {
    turn('sell');
    turn('yes');
    turn('Hamriyah Free Zone oil n gas last yr turnover over 40M aed');
    turn('Sharjah');

    service.updateFromMessage(chatId, message(`m-${++sequence}`, '10M to 20M USD $'));
    const record = service.getCurrentRecord(chatId);
    const directive = service.getDirective(chatId);

    expect(record?.desiredSellingPriceAed).toContain('36,725,000');
    expect(record?.desiredSellingPriceAed).toContain('73,450,000');
    expect(record?.status).toBe('qualified');
    expect(directive.shouldRespond).toBe(true);
    expect(directive.directResponse).toContain('initial SHARH review');
  });

  it('asks for the client name only when submitting for review', () => {
    turn('sell');
    turn('yes');
    turn('Boat trading company in Dubai, expected selling price AED 600k');

    const submit = service.handleNavigationCommand(chatId, 'submit for review');
    expect(submit.response).toContain('Could I have your name');
    const nameDirective = service.getDirective(chatId);
    service.confirmDirectiveSent(chatId, nameDirective);

    turn('Ansar');
    expect(service.getCurrentRecord(chatId)?.nextStep).toBe('submit');
    expect(service.getCurrentRecord(chatId)?.clientName).toBe('Ansar');
  });

  it('uses a one-time contextual re-entry prompt after a completed case', () => {
    turn('sell');
    turn('yes');
    turn('Boat trading company in Dubai, expected selling price AED 600k');

    const firstGreeting = service.handleNavigationCommand(chatId, 'Salam');
    expect(firstGreeting.response).toContain('request is saved with SHARH');
    expect(firstGreeting.response).toContain('selling another business');

    const secondGreeting = service.handleNavigationCommand(chatId, 'Hello');
    expect(secondGreeting.response).toBe('How can I help with your SHARH request?');
  });

  it('continues an existing buyer search when the buyer simply replies buy', () => {
    turn('buy');
    turn('Any profitable business in Dubai, budget AED 1m, minimum annual profit AED 100k');
    expect(service.getCurrentRecord(chatId)?.status).toBe('qualified');

    const greeting = service.handleNavigationCommand(chatId, 'Hello');
    expect(greeting.response).toContain('buyer search is saved');
    const before = service.getCurrentRecord(chatId);

    const continued = service.handleNavigationCommand(chatId, 'Buy');
    const after = service.getCurrentRecord(chatId);
    expect(continued.restartConfirmed).not.toBe(true);
    expect(continued.response).toContain('Continuing your buyer search');
    expect(after?.inquiryPurpose).toBe('buying');
    expect(after?.buyerBudgetAed).toBe(before?.buyerBudgetAed);
    expect(after?.buyerLocation).toBe(before?.buyerLocation);
  });

  it('creates separate buyer and seller cases without leaking previous answers', () => {
    turn('sell');
    turn('yes');
    turn('Boat trading company in Dubai, expected selling price AED 600k');

    const buyer = service.handleNavigationCommand(chatId, 'I want to buy a restaurant now');
    expect(buyer.restartConfirmed).toBe(true);
    expect(service.getCurrentRecord(chatId)?.inquiryPurpose).toBe('buying');
    expect(service.getCurrentRecord(chatId)?.businessType).toBe('');
    expect(buyer.response).toContain('separate buyer search');

    turn('Restaurant in Dubai under AED 1m');
    const seller = service.handleNavigationCommand(chatId, 'I also have a salon to sell');
    expect(seller.restartConfirmed).toBe(true);
    expect(service.getCurrentRecord(chatId)?.inquiryPurpose).toBe('selling');
    expect(service.getCurrentRecord(chatId)?.businessType).toBe('');
    expect(seller.response).toContain('separate seller request');
  });

  it('does not expose a WhatsApp LID as a phone number', () => {
    service.updateFromMessage(chatId, {
      ...message(`m-${++sequence}`, 'sell'),
      from: '208911705595993@lid',
    });

    expect(service.getCurrentRecord(chatId)?.clientPhone).toBe('');
  });

});
