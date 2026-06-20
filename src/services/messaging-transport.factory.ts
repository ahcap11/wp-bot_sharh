import { MessagingConfig, MessagingTransport } from '../types';
import { logger } from '../utils/logger';
import { WhatsAppService } from './whatsapp.service';
import { CloudApiTransport } from './cloud-api.service';

/**
 * Single switch point between messaging backends. The backend is selected by
 * config.kind (env WHATSAPP_TRANSPORT) and defaults to Baileys. Nothing else in
 * the app needs to change when switching to the Cloud API.
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
      return new WhatsAppService();
  }
}
