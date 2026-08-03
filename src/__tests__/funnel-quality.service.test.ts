import { FunnelQualityService } from '../services/funnel-quality.service';
import { SalesPlaybookService } from '../services/sales-playbook.service';

const service = new FunnelQualityService(new SalesPlaybookService());

describe('FunnelQualityService', () => {
  it('blocks guarantees and invented buyer claims', () => {
    const result = service.evaluate(
      'We guarantee a sale and already have a buyer.'
    );
    expect(result.passed).toBe(false);
    expect(result.issues.some(issue => issue.code === 'forbidden_claim')).toBe(true);
  });

  it('blocks multi-question interrogation', () => {
    const result = service.evaluate('What is your revenue? What is your profit?');
    expect(result.passed).toBe(false);
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'multiple_questions' }),
      ])
    );
  });

  it('accepts a concise factual next step', () => {
    expect(
      service.evaluate('Thank you. What is the business location?').passed
    ).toBe(true);
  });
});
