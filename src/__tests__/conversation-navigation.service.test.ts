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

describe('conversation navigation and updated seller terms', () => {
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

  it('uses the approved name question and centralized success-fee wording', () => {
    turn('I want to sell');
    expect(service.getDirective(chatId).directResponse).toBe('Could I have your name, please?');
    service.confirmDirectiveSent(chatId, service.getDirective(chatId));

    service.updateFromMessage(chatId, message(`m-${++sequence}`, 'Diana')); 
    const terms = service.getDirective(chatId).directResponse || '';
    expect(terms).toContain('5% for transactions above USD 200,000');
    expect(terms).toContain('flat USD 10,000');
    expect(terms).not.toContain('2%');
  });

  it('asks why when the seller rejects the terms', () => {
    turn('sell');
    turn('Diana');
    turn('no');

    expect(service.getDirective(chatId).directResponse).toContain('Which part of the terms');
    expect(service.getCurrentRecord(chatId)?.termsAccepted).toBe('no');
  });

  it('supports review, back, changing an answer, pausing, and resuming without AI', () => {
    turn('buy');
    turn('Diana');
    turn('Healthcare');
    turn('AED 2 million');
    turn('Dubai');

    const review = service.handleNavigationCommand(chatId, 'review my answers');
    expect(review.handled).toBe(true);
    expect(review.response).toContain('Healthcare');
    expect(review.response).toContain('Dubai');

    const directChange = service.handleNavigationCommand(chatId, 'change location to Abu Dhabi');
    expect(directChange.response).toContain('Updated');
    expect(service.getCurrentRecord(chatId)?.buyerLocation).toBe('Abu Dhabi');

    const change = service.handleNavigationCommand(chatId, 'change location');
    expect(change.response).toContain('update that answer');
    expect(service.getDirective(chatId).expectedField).toBe('buyer_location');

    const paused = service.handleNavigationCommand(chatId, 'pause');
    expect(paused.response).toContain('progress is saved');
    expect(service.getDirective(chatId).shouldRespond).toBe(false);

    const resumed = service.handleNavigationCommand(chatId, 'resume');
    expect(resumed.response).toContain('Continuing');
    expect(service.getDirective(chatId).expectedField).toBe('buyer_location');
  });

  it('requires confirmation before starting over and clears only active answers', () => {
    turn('sell');
    turn('Diana');

    const request = service.handleNavigationCommand(chatId, 'start over');
    expect(request.response).toContain('Reply 1 to confirm');
    expect(service.getCurrentRecord(chatId)?.clientName).toBe('Diana');

    const confirmed = service.handleNavigationCommand(chatId, '1');
    expect(confirmed.resetAiUsage).toBe(true);
    expect(service.getCurrentRecord(chatId)?.clientName).toBe('');
    expect(service.getDirective(chatId).expectedField).toBe('inquiry_purpose');
  });

  it('switches between buyer and seller routes without a new chat', () => {
    turn('buy');
    turn('Diana');
    turn('Healthcare');

    const switched = service.handleNavigationCommand(chatId, 'switch to selling');
    expect(switched.response).toContain('switched this request to selling');
    expect(service.getCurrentRecord(chatId)?.inquiryPurpose).toBe('selling');
    expect(service.getDirective(chatId).expectedField).toBe('seller_terms');
  });
});
