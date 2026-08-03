import { createHmac } from 'crypto';
import { CloudApiTransport } from '../services/cloud-api.service';
import { MessagingConfig } from '../types';

const config: MessagingConfig = {
  kind: 'cloud',
  baileysAuthDir: './auth_info_baileys',
  baileysReconnectBaseDelayMs: 5000,
  baileysReconnectMaxDelayMs: 120000,
  cloudPhoneNumberId: '123456789',
  cloudAccessToken: 'access-token',
  cloudVerifyToken: 'verify-token',
  cloudAppSecret: 'app-secret',
  cloudApiVersion: 'v26.0',
  cloudWebhookPath: '/webhooks/whatsapp',
  cloudSendTimeoutMs: 10000,
  cloudWebhookMaxBodyBytes: 1048576,
};

describe('CloudApiTransport', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.clearAllMocks();
  });

  it('verifies the Meta webhook challenge', async () => {
    const transport = new CloudApiTransport(config);
    await transport.initialize();

    expect(
      transport.verifyWebhookChallenge(
        new URLSearchParams({
          'hub.mode': 'subscribe',
          'hub.verify_token': 'verify-token',
          'hub.challenge': 'challenge-value',
        })
      )
    ).toBe('challenge-value');

    expect(
      transport.verifyWebhookChallenge(
        new URLSearchParams({
          'hub.mode': 'subscribe',
          'hub.verify_token': 'wrong',
          'hub.challenge': 'challenge-value',
        })
      )
    ).toBeNull();
  });

  it('sends text through the Graph API and returns provider message ids', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: jest
        .fn()
        .mockResolvedValue(JSON.stringify({ messages: [{ id: 'wamid.123' }] })),
    }) as jest.Mock;
    const transport = new CloudApiTransport(config);
    await transport.initialize();

    const result = await transport.sendMessageDetailed(
      '971502106179@s.whatsapp.net',
      'Hello'
    );

    expect(result).toEqual({
      success: true,
      providerMessageIds: ['wamid.123'],
    });
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/123456789/messages'),
      expect.objectContaining({ method: 'POST' })
    );
    const request = (global.fetch as jest.Mock).mock.calls[0]?.[1];
    expect(JSON.parse(request.body)).toMatchObject({
      messaging_product: 'whatsapp',
      to: '971502106179',
      type: 'text',
    });
  });

  it('validates the webhook signature and emits messages and delivery states', async () => {
    const transport = new CloudApiTransport(config);
    await transport.initialize();
    const onMessage = jest.fn();
    const onDelivery = jest.fn();
    transport.onMessage(onMessage);
    transport.onDeliveryStatus(onDelivery);

    const payload = {
      object: 'whatsapp_business_account',
      entry: [
        {
          changes: [
            {
              field: 'messages',
              value: {
                metadata: { phone_number_id: '123456789' },
                contacts: [
                  { wa_id: '971501234567', profile: { name: 'Sarah' } },
                ],
                messages: [
                  {
                    id: 'wamid.inbound',
                    from: '971501234567',
                    timestamp: '1785776400',
                    type: 'text',
                    text: { body: 'I want to sell my business' },
                  },
                ],
                statuses: [
                  {
                    id: 'wamid.outbound',
                    status: 'delivered',
                    timestamp: '1785776401',
                    recipient_id: '971501234567',
                  },
                ],
              },
            },
          ],
        },
      ],
    };
    const raw = Buffer.from(JSON.stringify(payload));
    const signature = createHmac('sha256', config.cloudAppSecret)
      .update(raw)
      .digest('hex');

    const result = await transport.handleWebhookRequest(raw, {
      'x-hub-signature-256': `sha256=${signature}`,
    });

    expect(result.statusCode).toBe(200);
    expect(onMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'wamid.inbound',
        from: '971501234567@s.whatsapp.net',
        content: 'I want to sell my business',
        senderName: 'Sarah',
      })
    );
    expect(onDelivery).toHaveBeenCalledWith(
      expect.objectContaining({
        providerMessageId: 'wamid.outbound',
        status: 'delivered',
      })
    );
  });


  it('ignores signed events for a different configured phone number', async () => {
    const transport = new CloudApiTransport(config);
    await transport.initialize();
    const onMessage = jest.fn();
    transport.onMessage(onMessage);

    const payload = {
      object: 'whatsapp_business_account',
      entry: [
        {
          changes: [
            {
              field: 'messages',
              value: {
                metadata: { phone_number_id: 'different-number-id' },
                messages: [
                  {
                    id: 'wamid.other',
                    from: '971501234567',
                    timestamp: '1785776400',
                    type: 'text',
                    text: { body: 'Ignore me' },
                  },
                ],
              },
            },
          ],
        },
      ],
    };
    const raw = Buffer.from(JSON.stringify(payload));
    const signature = createHmac('sha256', config.cloudAppSecret)
      .update(raw)
      .digest('hex');

    const result = await transport.handleWebhookRequest(raw, {
      'x-hub-signature-256': `sha256=${signature}`,
    });

    expect(result.statusCode).toBe(200);
    expect(onMessage).not.toHaveBeenCalled();
  });

  it('rejects webhook payloads with an invalid signature', async () => {
    const transport = new CloudApiTransport(config);
    await transport.initialize();
    const onMessage = jest.fn();
    transport.onMessage(onMessage);

    const result = await transport.handleWebhookRequest(
      Buffer.from(JSON.stringify({ object: 'whatsapp_business_account' })),
      { 'x-hub-signature-256': 'sha256=bad' }
    );

    expect(result.statusCode).toBe(401);
    expect(onMessage).not.toHaveBeenCalled();
  });
});
