import { PersistenceService } from '../services/persistence.service';
import { SharhSyncService } from '../services/sharh-sync.service';

const api = {
  isEnabled: () => true,
  getConfig: () => ({
    syncIntervalMs: 30_000,
    syncBatchSize: 20,
    syncMaxAttempts: 12,
  }),
  buildIdempotencyKey: (...parts: string[]) => parts.join(':'),
  forwardWhatsAppProviderEvent: jest.fn(async () => true),
} as any;

describe('verified provider webhook forwarding', () => {
  it('queues status-only payloads and removes inbound messages and contacts', async () => {
    const persistence = {
      getNamespace: () => ({}),
      setItem: jest.fn(),
      removeItem: jest.fn(),
    } as unknown as PersistenceService;
    const service = new SharhSyncService(api, persistence);

    service.enqueueProviderWebhook(
      Buffer.from(
        JSON.stringify({
          object: 'whatsapp_business_account',
          entry: [
            {
              id: 'waba',
              changes: [
                {
                  field: 'messages',
                  value: {
                    metadata: { phone_number_id: '123' },
                    contacts: [{ wa_id: '971500000000' }],
                    messages: [{ id: 'wamid.inbound', text: { body: 'secret' } }],
                    statuses: [{ id: 'wamid.outbound', status: 'delivered', timestamp: '1' }],
                  },
                },
              ],
            },
          ],
        })
      )
    );

    await service.flush();
    expect(api.forwardWhatsAppProviderEvent).toHaveBeenCalledTimes(1);
    const payload = api.forwardWhatsAppProviderEvent.mock.calls[0][0];
    const serialized = JSON.stringify(payload);
    expect(serialized).toContain('statuses');
    expect(serialized).not.toContain('contacts');
    expect(serialized).not.toContain('messages":[{');
    expect(serialized).not.toContain('secret');
  });

  it('does not queue message-only provider webhooks', async () => {
    api.forwardWhatsAppProviderEvent.mockClear();
    const service = new SharhSyncService(api, null);
    service.enqueueProviderWebhook(
      JSON.stringify({
        object: 'whatsapp_business_account',
        entry: [{ changes: [{ field: 'messages', value: { messages: [{ id: 'x' }] } }] }],
      })
    );
    await service.flush();
    expect(api.forwardWhatsAppProviderEvent).not.toHaveBeenCalled();
  });
});
