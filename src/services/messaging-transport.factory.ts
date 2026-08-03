import { MessagingConfig, MessagingTransport } from '../types';
import { logger } from '../utils/logger';
import { WhatsAppService } from './whatsapp.service';
import { CloudApiTransport } from './cloud-api.service';

/**
 * Single switch point between messaging backends. The backend is selected by
 * config.kind (env WHATSAPP_TRANSPORT) and defaults to the Baileys pilot.
 * Funnel and SHARH integration code remain transport-independent.
 */
export function createMessagingTransport(
  config: MessagingConfig
): MessagingTransport {
  switch (config.kind) {
    case 'cloud':
      logger.info('Messaging transport: WhatsApp Cloud API');
      return new CloudApiTransport(config);
    case 'baileys':
    default:
      logger.info('Messaging transport: Baileys (WhatsApp Web)');
      return new WhatsAppService(config);
  }
}
