import { LeadCaptureService } from '../services/lead-capture.service';
import type { WhatsAppMessage } from '../types';
import type { SalesMessageInterpretation } from '../services/sales-message-intelligence.types';

const interpretation = (
  classification: SalesMessageInterpretation['classification'],
  fields: SalesMessageInterpretation['fields'] = {},
  extra: Partial<SalesMessageInterpretation> = {}
): SalesMessageInterpretation => ({
  classification,
  confidence: 0.99,
  language: 'en',
  fields,
  corrections: extra.corrections || [],
  unknownFields: extra.unknownFields || [],
  questionType: extra.questionType || 'none',
  reason: extra.reason || '',
});

describe('sales message intelligence safeguards', () => {
  let service: LeadCaptureService;
  let sequence: number;
  const chatId = 'intelligence-test';

  const message = (content: string): WhatsAppMessage => ({
    id: `msg-${++sequence}`,
    from: '971500000001@s.whatsapp.net',
    to: chatId,
    timestamp: Date.now(),
    type: 'text',
    content,
    isGroup: false,
  });

  const turn = (
    content: string,
    result: SalesMessageInterpretation
  ) => {
    const update = service.updateFromMessage(chatId, message(content), result);
    const directive = service.getDirective(chatId);
    if (directive.directResponse) {
      service.confirmDirectiveSent(chatId, directive);
    }
    return { update, directive };
  };

  beforeEach(() => {
    service = new LeadCaptureService(null);
    sequence = 0;
    turn('I want to sell', interpretation('valid_answer', { inquiry_purpose: 'selling' }));
    turn('Ali', interpretation('valid_answer', { client_name: 'Ali' }));
    turn('yes', interpretation('valid_answer', { seller_terms: 'yes' }));
    turn('Cafe', interpretation('valid_answer', { business_type: 'Cafe' }));
    turn('Dubai Marina', interpretation('valid_answer', { business_location: 'Dubai Marina' }));
  });

  it('rejects nonsense instead of moving to the next field', () => {
    const { directive } = turn(
      'bazilion',
      interpretation('nonsense', {}, { reason: 'Not a numeric revenue value' })
    );

    expect(service.getCurrentRecord(chatId)?.annualRevenueAed).toBe('');
    expect(directive.expectedField).toBe('annual_revenue_aed');
    expect(directive.directResponse).toContain('could not use');
  });

  it('extracts several answers and does not ask them again', () => {
    turn(
      'Revenue 1.5m, profit 20k monthly, 5 employees',
      interpretation('multiple_answers', {
        annual_revenue_aed: 'AED 1,500,000',
        monthly_net_profit_aed: 'AED 20,000',
        employee_count: '5',
      })
    );

    const record = service.getCurrentRecord(chatId);
    expect(record?.annualRevenueAed).toBe('AED 1,500,000');
    expect(record?.monthlyNetProfitAed).toBe('AED 20,000');
    expect(record?.employeeCount).toBe('5');
    expect(record?.nextField).toBe('monthly_operating_expenses_aed');
  });

  it('applies explicit corrections without polluting the current field', () => {
    turn(
      'Revenue 1.5m, profit 20k monthly',
      interpretation('multiple_answers', {
        annual_revenue_aed: 'AED 1,500,000',
        monthly_net_profit_aed: 'AED 20,000',
      })
    );
    turn(
      'Actually revenue is 2m',
      interpretation(
        'correction',
        { annual_revenue_aed: 'AED 2,000,000' },
        { corrections: ['annual_revenue_aed'] }
      )
    );

    const record = service.getCurrentRecord(chatId);
    expect(record?.annualRevenueAed).toBe('AED 2,000,000');
    expect(record?.monthlyOperatingExpensesAed).toBe('');
  });

  it('asks for confirmation when figures contradict each other', () => {
    const { directive } = turn(
      'Revenue 150k and monthly profit 20k',
      interpretation('multiple_answers', {
        annual_revenue_aed: 'AED 150,000',
        monthly_net_profit_aed: 'AED 20,000',
      })
    );

    expect(directive.directResponse).toContain('conflicts');
    turn('no', interpretation('valid_answer'));
    expect(service.getCurrentRecord(chatId)?.monthlyNetProfitAed).toBe('');
  });

  it('accepts unknown and continues instead of trapping the user', () => {
    turn(
      'I do not know',
      interpretation('unknown', {}, { unknownFields: ['annual_revenue_aed'] })
    );

    expect(service.getCurrentRecord(chatId)?.annualRevenueAed).toBe(
      'Unknown / to confirm'
    );
  });
});
