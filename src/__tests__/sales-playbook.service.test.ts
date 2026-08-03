import { SalesPlaybookService } from '../services/sales-playbook.service';

describe('SalesPlaybookService', () => {
  it('loads the supported version and rejects unknown versions', () => {
    expect(new SalesPlaybookService().getVersion()).toBe('1.0.0');
    expect(() => new SalesPlaybookService('unknown')).toThrow(
      'Unsupported SALES_PLAYBOOK_VERSION'
    );
  });

  it.each([
    ['What commission do you charge?', 'commission'],
    ['How do you protect confidentiality?', 'confidentiality'],
    ['Do I need to register?', 'registration'],
    ['Can you tell me the final valuation?', 'valuation'],
    ['I only want serious buyers', 'buyer_quality'],
    ['Is the agreement exclusive?', 'exclusivity'],
    ['What documents are required?', 'documents'],
  ])('detects %s as %s', (message, topic) => {
    expect(new SalesPlaybookService().detectObjection(message)).toBe(topic);
  });
});
