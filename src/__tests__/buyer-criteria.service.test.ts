import { BuyerCriteriaService } from '../services/buyer-criteria.service';
import type { LeadCaptureRecord } from '../services/lead-capture.service';

const record = (
  overrides: Partial<LeadCaptureRecord> = {}
): LeadCaptureRecord =>
  ({
    businessType: 'Any profitable business',
    buyerLocation: '',
    buyerBudgetAed: 'AED 1,000,000',
    buyerMinimumAnnualProfitAed: 'AED 300,000',
    buyerMinimumRoiPct: '',
    buyerInvolvement: 'Passive required',
    buyerAdditionalComments: '',
    buyerReturnPeriod: 'annual',
    buyerExcludedSectors: '',
    buyerProfitableOnly: true,
    ...overrides,
  }) as LeadCaptureRecord;

describe('BuyerCriteriaService', () => {
  const service = new BuyerCriteriaService();

  it('parses formatted AED values without reducing one million to one', () => {
    expect(service.fromRecord(record())).toMatchObject({
      maxBudgetAed: 1_000_000,
      minAnnualProfitAed: 300_000,
      profitableOnly: true,
      passivePreference: 'required',
    });
  });

  it('uses the upper budget bound and lower profit bound', () => {
    expect(
      service.fromRecord(
        record({
          buyerBudgetAed: 'AED 800,000–1,200,000',
          buyerMinimumAnnualProfitAed: 'AED 250,000–350,000',
        })
      )
    ).toMatchObject({
      maxBudgetAed: 1_200_000,
      minAnnualProfitAed: 250_000,
    });
  });

  it('lets an explicit active-management update override an older passive comment', () => {
    expect(
      service.fromRecord(
        record({
          buyerInvolvement: 'Open to either',
          buyerAdditionalComments: 'Originally asked for a passive business',
        })
      ).passivePreference
    ).toBe('any');
  });

  it('asks for annual versus monthly when the return period is ambiguous', () => {
    const criteria = service.fromRecord(
      record({
        buyerMinimumAnnualProfitAed: '',
        buyerReturnPeriod: 'ambiguous',
        buyerAdditionalComments: 'It should bring more than AED 300,000',
      })
    );

    expect(criteria.ambiguousReturnAmountAed).toBe(300_000);
    expect(service.clarificationMessage(criteria, 'en')).toContain(
      'annual net profit or monthly net profit'
    );
  });
});
