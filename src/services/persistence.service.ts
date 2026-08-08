import fs from 'fs';
import path from 'path';
import { logger } from '../utils/logger';

type Namespaces = Record<string, Record<string, unknown>>;

/**
 * File-backed JSON persistence store.
 *
 * Keeps an in-memory snapshot that mirrors the on-disk file, with debounced,
 * atomic writes (write-to-temp then rename) so a crash mid-write cannot corrupt
 * the saved state. Intended for pilot-scale durability across restarts/redeploys
 * without requiring an external database.
 */
export class PersistenceService {
  private data: Namespaces = {};
  private readonly filePath: string;
  private readonly saveDebounceMs: number;
  private saveTimer: NodeJS.Timeout | null = null;
  // Serialize writes through one promise chain. A caller awaiting flush() must
  // not return merely because another write is already in flight; otherwise a
  // crash can still lose the inbound/pending marker that the caller believed
  // was durable.
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(filePath: string, saveDebounceMs: number = 1000) {
    this.filePath = filePath;
    this.saveDebounceMs = saveDebounceMs;
  }

  /**
   * Synchronously load the snapshot from disk (call once at startup).
   */
  load(): void {
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, 'utf8');
        if (raw.trim()) {
          this.data = JSON.parse(raw) as Namespaces;
        }
      }
      logger.info('Persistence store loaded', {
        filePath: this.filePath,
        namespaces: Object.keys(this.data),
      });
    } catch (error) {
      logger.error(
        'Failed to load persistence store; starting with empty state',
        {
          filePath: this.filePath,
          error: error instanceof Error ? error.message : 'Unknown error',
        }
      );
      this.data = {};
    }
  }

  /**
   * Return all stored items for a namespace as a plain object.
   */
  getNamespace<T>(namespace: string): Record<string, T> {
    return (this.data[namespace] as Record<string, T>) || {};
  }

  /**
   * Upsert an item and schedule a save.
   */
  setItem(namespace: string, key: string, value: unknown): void {
    if (!this.data[namespace]) {
      this.data[namespace] = {};
    }
    this.data[namespace][key] = value;
    this.scheduleSave();
  }

  /**
   * Remove an item and schedule a save.
   */
  removeItem(namespace: string, key: string): void {
    const bucket = this.data[namespace];
    if (bucket && key in bucket) {
      delete bucket[key];
      this.scheduleSave();
    }
  }

  private scheduleSave(): void {
    if (this.saveTimer) {
      return;
    }
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.flush().catch(error => {
        logger.error('Scheduled persistence flush failed', {
          filePath: this.filePath,
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      });
    }, this.saveDebounceMs);
    // Do not let a pending save keep the process alive on shutdown.
    this.saveTimer.unref();
  }

  /**
   * Force an immediate, atomic write of the current snapshot.
   */
  async flush(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }

    // Queue a real snapshot write behind any existing one and await this exact
    // write. This deliberately favors correctness over micro-optimizing a tiny
    // pilot-scale JSON file.
    const write = async (): Promise<void> => {
      try {
        const dir = path.dirname(this.filePath);
        await fs.promises.mkdir(dir, { recursive: true });
        const tempPath = `${this.filePath}.tmp`;
        await fs.promises.writeFile(tempPath, JSON.stringify(this.data), 'utf8');
        await fs.promises.rename(tempPath, this.filePath);
      } catch (error) {
        logger.error('Failed to persist state to disk', {
          filePath: this.filePath,
          error: error instanceof Error ? error.message : 'Unknown error',
        });
        // Durability is part of the message-processing contract. Never tell a
        // caller that its pending/completion marker was committed when the disk
        // write actually failed.
        throw error;
      }
    };

    this.writeQueue = this.writeQueue.then(write, write);
    await this.writeQueue;
  }

}
