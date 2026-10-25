import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { VocabularyItem } from '../../shared/types';
import { logger } from '../lib/logger';

/**
 * Saved-phrase store, scoped by workspace/client id so one workspace's phrases
 * are never returned to another.
 *
 * Persistence is opt-in (`ENABLE_VOCAB_PERSISTENCE=1`) and file-based: that is
 * honest for a single-workspace deployment. When real multi-user accounts are
 * added, replace this class with a Postgres/Supabase implementation behind the
 * same four methods. See README "Data model".
 */
export class VocabularyStore {
  private readonly byOwner = new Map<string, VocabularyItem[]>();
  private loaded = false;

  constructor(
    private readonly options: {
      persist: boolean;
      filePath: string;
    },
  ) {}

  private get absolutePath(): string {
    return resolve(process.cwd(), this.options.filePath);
  }

  private async loadOnce(): Promise<void> {
    if (this.loaded || !this.options.persist) {
      this.loaded = true;
      return;
    }
    this.loaded = true;
    try {
      const raw = await readFile(this.absolutePath, 'utf8');
      const parsed = JSON.parse(raw) as Record<string, VocabularyItem[]>;
      for (const [owner, items] of Object.entries(parsed)) {
        if (Array.isArray(items)) this.byOwner.set(owner, items);
      }
      logger.info('vocabulary.loaded', { owners: Object.keys(parsed).length });
    } catch {
      // First run: no file yet. Not an error.
    }
  }

  private async persist(): Promise<void> {
    if (!this.options.persist) return;
    try {
      const path = this.absolutePath;
      await mkdir(dirname(path), { recursive: true });
      const payload = JSON.stringify(Object.fromEntries(this.byOwner), null, 2);
      const tempPath = `${path}.tmp`;
      await writeFile(tempPath, payload, 'utf8');
      await rename(tempPath, path);
    } catch (error) {
      logger.warn('vocabulary.persist_failed', {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async list(owner: string): Promise<VocabularyItem[]> {
    await this.loadOnce();
    return [...(this.byOwner.get(owner) ?? [])].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async add(
    owner: string,
    input: { term: string; meaningEn: string; meaningHi: string | null; example: string | null },
  ): Promise<VocabularyItem> {
    await this.loadOnce();
    const item: VocabularyItem = {
      id: randomUUID(),
      term: input.term.trim(),
      meaningEn: input.meaningEn.trim(),
      meaningHi: input.meaningHi,
      example: input.example,
      createdAt: new Date().toISOString(),
    };
    const existing = this.byOwner.get(owner) ?? [];
    // Replace an identical term instead of duplicating it.
    const deduped = existing.filter((entry) => entry.term.toLowerCase() !== item.term.toLowerCase());
    this.byOwner.set(owner, [item, ...deduped].slice(0, 500));
    await this.persist();
    return item;
  }

  async remove(owner: string, id: string): Promise<boolean> {
    await this.loadOnce();
    const existing = this.byOwner.get(owner) ?? [];
    const next = existing.filter((entry) => entry.id !== id);
    if (next.length === existing.length) return false;
    this.byOwner.set(owner, next);
    await this.persist();
    return true;
  }

  async clear(owner: string): Promise<number> {
    await this.loadOnce();
    const count = (this.byOwner.get(owner) ?? []).length;
    this.byOwner.set(owner, []);
    await this.persist();
    return count;
  }
}
