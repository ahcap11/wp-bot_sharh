import { LeadCaptureService } from '../services/lead-capture.service';
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

describe('LeadCaptureService', () => {
  let leadCaptureService: LeadCaptureService;

  beforeEach(() => {
    leadCaptureService = new LeadCaptureService();
  });

  it('should qualify a buyer only once a sector of interest is known', () => {
    const firstUpdate = leadCaptureService.updateFromMessage(
      'chat-1',
      buildMessage('m1', 'My name is John Carter')
    );

    expect(firstUpdate.shouldPersist).toBe(true);
    expect(firstUpdate.record?.status).toBe('collecting');
    expect(firstUpdate.record?.clientName).toBe('John Carter');
    expect(firstUpdate.record?.clientPhone).toBe('971501234567');

    const secondUpdate = leadCaptureService.updateFromMessage(
      'chat-1',
      buildMessage('m2', 'I want to buy a business')
    );

    // Name + phone + purpose alone must NOT qualify a buyer anymore.
    expect(secondUpdate.record?.status).toBe('collecting');
    expect(secondUpdate.record?.inquiryPurpose).toBe('buying');

    const thirdUpdate = leadCaptureService.updateFromMessage(
      'chat-1',
      buildMessage('m3', 'Business type: restaurant')
    );

    expect(thirdUpdate.record?.businessType).toBeTruthy();
    expect(thirdUpdate.record?.status).toBe('qualified_lead');
    expect(thirdUpdate.record?.escalationReason).toBe('qualified_lead');
    expect(thirdUpdate.record?.inquiryPurpose).toBe('buying');
  });

  it('should require selling-specific fields before qualifying a seller', () => {
    leadCaptureService.updateFromMessage(
      'chat-sell',
      buildMessage('s1', 'My name is Sarah Lee')
    );
    leadCaptureService.updateFromMessage(
      'chat-sell',
      buildMessage('s2', 'I want to sell my business')
    );

    const businessUpdate = leadCaptureService.updateFromMessage(
      'chat-sell',
      buildMessage('s3', 'I run a vegan restaurant chain')
    );
    expect(businessUpdate.record?.status).toBe('collecting');

    leadCaptureService.updateFromMessage(
      'chat-sell',
      buildMessage('s4', 'Our annual revenue is 5 million')
    );

    const finalUpdate = leadCaptureService.updateFromMessage(
      'chat-sell',
      buildMessage('s5', 'The desired selling price is 4.2 million')
    );

    expect(finalUpdate.record?.inquiryPurpose).toBe('selling');
    expect(finalUpdate.record?.businessType).toBeTruthy();
    expect(finalUpdate.record?.annualRevenueAed).toContain('AED');
    expect(finalUpdate.record?.desiredSellingPriceAed).toContain('AED');
    expect(finalUpdate.record?.status).toBe('qualified_lead');
  });

  it('should mark early escalation when manager is requested', () => {
    leadCaptureService.updateFromMessage(
      'chat-2',
      buildMessage('m1', 'My name is Alex')
    );

    const escalationUpdate = leadCaptureService.updateFromMessage(
      'chat-2',
      buildMessage('m2', 'Please connect me to a live manager now')
    );

    expect(escalationUpdate.shouldPersist).toBe(true);
    expect(escalationUpdate.record?.status).toBe('early_escalation');
    expect(escalationUpdate.record?.escalationReason).toBe('early_escalation');
    expect(escalationUpdate.record?.notes).toContain('live manager');
  });

  it('should detect seller inbound from first message', () => {
    const update = leadCaptureService.updateFromMessage(
      'chat-seller-entry',
      buildMessage('s0', 'I want to sell my business')
    );

    expect(update.record?.inquiryPurpose).toBe('selling');
    expect(
      leadCaptureService.getConversationContext('chat-seller-entry')
    ).toContain('Seller inbound');
  });

  it('should detect broker lead and escalate on first message', () => {
    const update = leadCaptureService.updateFromMessage(
      'chat-broker-entry',
      buildMessage(
        'b0',
        "Hi, I'm a SHARH broker interested in discussing a lead: Business · UAE (Score 57/100)"
      )
    );

    expect(update.record?.status).toBe('early_escalation');
    expect(update.record?.notes).toContain('SHARH broker lead discussion');
    expect(update.record?.notes).toContain('57/100');
    expect(
      leadCaptureService.getConversationContext('chat-broker-entry')
    ).toContain('broker lead discussion');
  });

  it('should ignore duplicate message ids', () => {
    const update = leadCaptureService.updateFromMessage(
      'chat-3',
      buildMessage('same-id', 'My name is Sam')
    );

    expect(update.shouldPersist).toBe(true);

    const duplicate = leadCaptureService.updateFromMessage(
      'chat-3',
      buildMessage('same-id', 'My name is Sam')
    );

    expect(duplicate.shouldPersist).toBe(false);
  });
});
