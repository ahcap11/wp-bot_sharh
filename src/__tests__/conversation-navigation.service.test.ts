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
    turn('Restaurant in Dubai with annual revenue AED 1m');

    const request = service.handleNavigationCommand(chatId, 'start over');
    expect(request.response).toContain('Reply 1 to confirm');
    expect(service.getCurrentRecord(chatId)?.businessType).toBe('Restaurant');

    const confirmed = service.handleNavigationCommand(chatId, '1');
    expect(confirmed.resetAiUsage).toBe(true);
    expect(service.getCurrentRecord(chatId)?.businessType).toBe('');
    expect(service.getDirective(chatId).expectedField).toBe('inquiry_purpose');
  });

  it('switches between buyer and seller routes without a new chat', () => {
    turn('buy');
    turn('Healthcare in Dubai');

    const switched = service.handleNavigationCommand(chatId, 'switch to selling');
    expect(switched.response).toContain('switched this request to selling');
    expect(service.getCurrentRecord(chatId)?.inquiryPurpose).toBe('selling');
    expect(service.getDirective(chatId).expectedField).toBe('seller_terms');
  });

  it('supports seller submit, contact, details, website and continue-later choices', () => {
    turn('sell');
    turn('yes');
    turn('Restaurant in Dubai, annual revenue AED 1m');

    const details = service.handleNavigationCommand(chatId, '2');
    expect(details.response).toContain('additional details in one message');

    service.updateFromMessage(chatId, message(`m-${++sequence}`, '10 employees, no debt, monthly profit AED 30k'));
    const contact = service.handleNavigationCommand(chatId, '3');
    expect(contact.response).toContain('convenient time');
  });
});
