import * as fs from 'node:fs';

/**
 * Watches the transcripts and events directories and coalesces bursts of writes into a
 * single debounced callback. `fs.watch` is recursive on macOS/Windows; on Linux we fall
 * back to polling the directory tree every 1.5s.
 */
export class ActivityWatcher {
  private watchers: fs.FSWatcher[] = [];
  private poll: NodeJS.Timeout | undefined;
  private timer: NodeJS.Timeout | undefined;
  private lastSignature = '';

  constructor(
    private readonly dirs: string[],
    private readonly onChange: () => void,
    private readonly debounceMs = 250,
  ) {}

  start(): void {
    this.stop();
    for (const dir of this.dirs) {
      try {
        fs.mkdirSync(dir, { recursive: true });
      } catch {
        /* the dir may be read-only; polling covers it */
      }
      try {
        const w = fs.watch(dir, { recursive: true, persistent: false }, () => this.schedule());
        w.on('error', () => this.ensurePolling());
        this.watchers.push(w);
      } catch {
        this.ensurePolling();
      }
    }
    // Recursive fs.watch on Linux throws ERR_FEATURE_UNAVAILABLE_ON_PLATFORM before Node 20; be defensive.
    if (process.platform === 'linux') this.ensurePolling();
  }

  stop(): void {
    for (const w of this.watchers) w.close();
    this.watchers = [];
    if (this.poll) clearInterval(this.poll);
    this.poll = undefined;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private ensurePolling(): void {
    if (this.poll) return;
    this.poll = setInterval(() => {
      const sig = this.signature();
      if (sig !== this.lastSignature) {
        this.lastSignature = sig;
        this.schedule();
      }
    }, 1500);
  }

  private signature(): string {
    const parts: string[] = [];
    const visit = (dir: string, depth: number) => {
      if (depth > 3) return;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const p = `${dir}/${e.name}`;
        if (e.isDirectory()) visit(p, depth + 1);
        else {
          try {
            parts.push(`${p}:${fs.statSync(p).mtimeMs}`);
          } catch {
            /* vanished */
          }
        }
      }
    };
    for (const d of this.dirs) visit(d, 0);
    return parts.join('|');
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.onChange();
    }, this.debounceMs);
  }
}
