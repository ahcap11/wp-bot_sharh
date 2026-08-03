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
  private writing: boolean = false;
  private pendingWrite: boolean = false;

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
      void this.flush();
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

    if (this.writing) {
      // A write is already in flight; mark that another is needed afterwards.
      this.pendingWrite = true;
      return;
    }

    this.writing = true;
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
    } finally {
      this.writing = false;
      if (this.pendingWrite) {
        this.pendingWrite = false;
        await this.flush();
      }
    }
  }
}
