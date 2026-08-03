import { ListingSearchService } from '../services/listing-search.service';
import { NeonReadService } from '../services/neon-read.service';
import { SharhApiService } from '../services/sharh-api.service';

describe('ListingSearchService', () => {
  it('does not use legacy fallback for an exact code rejected by SHARH', async () => {
    const sharh = {
      isEnabled: jest.fn().mockReturnValue(true),
      searchPublicListings: jest.fn().mockResolvedValue([]),
    } as unknown as SharhApiService;
    const neon = {
      isEnabled: jest.fn().mockReturnValue(true),
      searchListings: jest.fn().mockResolvedValue([{ title: 'stale listing' }]),
    } as unknown as NeonReadService;
    const service = new ListingSearchService(sharh, neon, true);

    await expect(service.searchListings('SH-0099')).resolves.toEqual([]);
    expect(neon.searchListings).not.toHaveBeenCalled();
  });

  it('uses Neon only as an explicit migration fallback', async () => {
    const sharh = {
      isEnabled: jest.fn().mockReturnValue(true),
      searchPublicListings: jest.fn().mockResolvedValue([]),
    } as unknown as SharhApiService;
    const neon = {
      isEnabled: jest.fn().mockReturnValue(true),
      searchListings: jest
        .fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ title: 'Dubai restaurant' }]),
    } as unknown as NeonReadService;
    const service = new ListingSearchService(sharh, neon, true);

    const rows = await service.searchListings(
      'I am looking to buy a restaurant in Dubai'
    );

    expect(rows).toEqual([{ title: 'Dubai restaurant' }]);
    expect(neon.searchListings).toHaveBeenCalled();
  });
});
