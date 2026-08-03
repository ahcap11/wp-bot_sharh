import { ChatHistoryService } from '../services/chat-history.service';
import { WhatsAppMessage } from '../types';

const buildMessage = (
  id: string,
  content: string,
  timestamp = Date.now()
): WhatsAppMessage => ({
  id,
  from: 'user@s.whatsapp.net',
  to: 'user@s.whatsapp.net',
  timestamp,
  type: 'text',
  content,
  isGroup: false,
  isFromBot: false,
});

describe('ChatHistoryService', () => {
  let service: ChatHistoryService;

  beforeEach(() => {
    service = new ChatHistoryService(3);
  });

  it('stores and retrieves messages per chat', () => {
    service.addMessage('chat-1', buildMessage('m1', 'hello'));
    service.addMessage('chat-1', buildMessage('m2', 'world'));

    const history = service.getChatHistory('chat-1');
    expect(history).toHaveLength(2);
    expect(history.map(m => m.content)).toEqual(['hello', 'world']);
  });

  it('caps history at the configured max length', () => {
    service.addMessage('chat-1', buildMessage('m1', 'one'));
    service.addMessage('chat-1', buildMessage('m2', 'two'));
    service.addMessage('chat-1', buildMessage('m3', 'three'));
    service.addMessage('chat-1', buildMessage('m4', 'four'));

    const history = service.getChatHistory('chat-1');
    expect(history).toHaveLength(3);
    expect(history.map(m => m.content)).toEqual(['two', 'three', 'four']);
  });

  it('returns a copy so external mutation cannot corrupt internal state', () => {
    service.addMessage('chat-1', buildMessage('m1', 'hello'));
    const history = service.getChatHistory('chat-1');
    history.push(buildMessage('rogue', 'tampered'));

    expect(service.getChatHistory('chat-1')).toHaveLength(1);
  });

  it('limits conversation context to the requested window', () => {
    for (let i = 0; i < 3; i += 1) {
      service.addMessage('chat-1', buildMessage(`m${i}`, `msg ${i}`));
    }

    const context = service.getConversationContext('chat-1', 2);
    expect(context).toHaveLength(2);
    expect(context[context.length - 1]?.content).toBe('msg 2');
  });

  it('searches messages case-insensitively', () => {
    service.addMessage(
      'chat-1',
      buildMessage('m1', 'Looking for a Vegan business')
    );
    service.addMessage('chat-1', buildMessage('m2', 'Unrelated text'));

    const results = service.searchMessages('chat-1', 'vegan');
    expect(results).toHaveLength(1);
    expect(results[0]?.id).toBe('m1');
  });

  it('tracks totals across chats', () => {
    service.addMessage('chat-1', buildMessage('m1', 'a'));
    service.addMessage('chat-2', buildMessage('m2', 'b'));
    service.addMessage('chat-2', buildMessage('m3', 'c'));

    expect(service.getTotalChats()).toBe(2);
    expect(service.getTotalMessages()).toBe(3);
  });

  it('clears history for a single chat', () => {
    service.addMessage('chat-1', buildMessage('m1', 'a'));
    service.clearChatHistory('chat-1');

    expect(service.getChatHistory('chat-1')).toEqual([]);
    expect(service.getTotalChats()).toBe(0);
  });

  it('exports and re-imports history round-trip', () => {
    service.addMessage('chat-1', buildMessage('m1', 'persist me'));
    const exported = service.exportChatHistory('chat-1');
    expect(exported).not.toBeNull();

    const fresh = new ChatHistoryService(3);
    const imported = fresh.importChatHistory('chat-1', exported as string);

    expect(imported).toBe(true);
    expect(fresh.getChatHistory('chat-1')[0]?.content).toBe('persist me');
  });

  it('rejects imports with mismatched chat ids', () => {
    const payload = JSON.stringify({
      chatId: 'other',
      messages: [],
      lastUpdated: Date.now(),
    });
    expect(service.importChatHistory('chat-1', payload)).toBe(false);
  });

  it('cleans up histories older than the cutoff', () => {
    service.addMessage('old-chat', buildMessage('m1', 'stale'));
    const stale = service.exportChatHistory('old-chat');
    const parsed = JSON.parse(stale as string);
    parsed.lastUpdated = Date.now() - 40 * 24 * 60 * 60 * 1000;
    service.importChatHistory('old-chat', JSON.stringify(parsed));

    service.addMessage('fresh-chat', buildMessage('m2', 'recent'));

    const cleaned = service.cleanupOldHistories(30);
    expect(cleaned).toBe(1);
    expect(service.getChatHistory('old-chat')).toEqual([]);
    expect(service.getChatHistory('fresh-chat')).toHaveLength(1);
  });
});
