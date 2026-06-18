import fs from 'fs';
import os from 'os';
import path from 'path';
import { PersistenceService } from '../services/persistence.service';
import { ChatHistoryService } from '../services/chat-history.service';
import { LeadCaptureService } from '../services/lead-capture.service';
import { WhatsAppMessage } from '../types';

const makeTempPath = (): string =>
  path.join(
    os.tmpdir(),
    `hydration-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    'state.json'
  );

const buildMessage = (id: string, content: string): WhatsAppMessage => ({
  id,
  from: '971501234567@s.whatsapp.net',
  to: '971501234567@s.whatsapp.net',
  timestamp: Date.now(),
  type: 'text',
  content,
  isGroup: false,
  isFromBot: false,
});

describe('state persistence across restarts', () => {
  const created: string[] = [];

  afterAll(() => {
    for (const filePath of created) {
      try {
        fs.rmSync(path.dirname(filePath), { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  });

  it('restores chat history into a new service instance', async () => {
    const filePath = makeTempPath();
    created.push(filePath);

    const store = new PersistenceService(filePath, 1);
    store.load();
    const history = new ChatHistoryService(50, store);
    history.addMessage('chat-1', buildMessage('m1', 'hello world'));
    await store.flush();

    // Simulate a restart: brand new store + service reading the same file.
    const reloadedStore = new PersistenceService(filePath, 1);
    reloadedStore.load();
    const restored = new ChatHistoryService(50, reloadedStore);

    const messages = restored.getChatHistory('chat-1');
    expect(messages).toHaveLength(1);
    expect(messages[0]?.content).toBe('hello world');
  });

  it('restores lead progress and de-duplicates already-processed messages', async () => {
    const filePath = makeTempPath();
    created.push(filePath);

    const store = new PersistenceService(filePath, 1);
    store.load();
    const leads = new LeadCaptureService(store);
    const first = leads.updateFromMessage(
      'chat-1',
      buildMessage('m1', 'My name is John Carter')
    );
    expect(first.shouldPersist).toBe(true);
    await store.flush();

    // Restart: a new service hydrated from disk should remember processed ids.
    const reloadedStore = new PersistenceService(filePath, 1);
    reloadedStore.load();
    const restored = new LeadCaptureService(reloadedStore);

    const duplicate = restored.updateFromMessage(
      'chat-1',
      buildMessage('m1', 'My name is John Carter')
    );
    expect(duplicate.shouldPersist).toBe(false);
  });
});
