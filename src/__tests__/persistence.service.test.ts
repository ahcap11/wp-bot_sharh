import fs from 'fs';
import os from 'os';
import path from 'path';
import { PersistenceService } from '../services/persistence.service';

const makeTempPath = (): string =>
  path.join(
    os.tmpdir(),
    `persistence-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    'state.json'
  );

describe('PersistenceService', () => {
  const created: string[] = [];

  const newStore = (
    debounce = 5
  ): { store: PersistenceService; filePath: string } => {
    const filePath = makeTempPath();
    created.push(filePath);
    return { store: new PersistenceService(filePath, debounce), filePath };
  };

  afterAll(() => {
    for (const filePath of created) {
      try {
        fs.rmSync(path.dirname(filePath), { recursive: true, force: true });
      } catch {
        // ignore cleanup errors
      }
    }
  });

  it('persists items and reloads them in a fresh instance', async () => {
    const { store, filePath } = newStore();
    store.setItem('roles', 'chat-1', 'sales');
    store.setItem('roles', 'chat-2', 'support');
    await store.flush();

    const reloaded = new PersistenceService(filePath);
    reloaded.load();

    expect(reloaded.getNamespace('roles')).toEqual({
      'chat-1': 'sales',
      'chat-2': 'support',
    });
  });

  it('writes the file atomically and leaves no temp file', async () => {
    const { store, filePath } = newStore();
    store.setItem('ns', 'k', { value: 1 });
    await store.flush();

    expect(fs.existsSync(filePath)).toBe(true);
    expect(fs.existsSync(`${filePath}.tmp`)).toBe(false);
  });

  it('removes items', async () => {
    const { store, filePath } = newStore();
    store.setItem('ns', 'keep', 1);
    store.setItem('ns', 'drop', 2);
    store.removeItem('ns', 'drop');
    await store.flush();

    const reloaded = new PersistenceService(filePath);
    reloaded.load();

    expect(reloaded.getNamespace('ns')).toEqual({ keep: 1 });
  });

  it('returns an empty object for unknown namespaces', () => {
    const { store } = newStore();
    expect(store.getNamespace('missing')).toEqual({});
  });

  it('starts empty when the backing file does not exist', () => {
    const { store } = newStore();
    store.load();
    expect(store.getNamespace('anything')).toEqual({});
  });

  it('debounces multiple writes into a single persisted snapshot', async () => {
    const { store, filePath } = newStore(20);
    store.setItem('ns', 'a', 1);
    store.setItem('ns', 'b', 2);
    store.setItem('ns', 'c', 3);
    await store.flush();

    const reloaded = new PersistenceService(filePath);
    reloaded.load();
    expect(reloaded.getNamespace('ns')).toEqual({ a: 1, b: 2, c: 3 });
  });
});
