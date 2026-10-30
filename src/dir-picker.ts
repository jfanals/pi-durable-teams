import { clean as cleanText, formatAgo, type RecentFolder } from "./status.ts";
import { directories, markers, errorText } from "./directories.ts";
import { existsSync, openSync, readSync, closeSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { Key, matchesKey, truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";

const clean = (text: string) => cleanText(text).replace(/[\x00-\x1f\x7f]/g, " ");
function instructions(path: string): string[] {
  if (!existsSync(join(path, "AGENTS.md"))) return [];
  let fd: number | undefined;
  try {
    fd = openSync(join(path, "AGENTS.md"), "r");
    const buffer = Buffer.alloc(2048);
    const size = readSync(fd, buffer, 0, buffer.length, 0);
    return ["", "AGENTS.md", ...buffer.toString("utf8", 0, size).split(/\r?\n/).slice(0, 4).map(clean)];
  } catch (error) { return [errorText(error)]; }
  finally { if (fd !== undefined) closeSync(fd); }
}
const home = (path: string) => path === homedir() || path.startsWith(homedir() + "/") ? "~" + path.slice(homedir().length) : path;
type Row = { path: string; label: string; recent?: RecentFolder };

/** Local picker using the same directory listing as the host API. */
export class DirPicker implements Component {
  private cache = new Map<string, ReturnType<typeof directories> & { markers: string; instructions: string[]; loaded: boolean }>();
  private snapshot(path: string, listing = true) {
    let entry = this.cache.get(path);
    if (!entry) {
      entry = { names: [], markers: markers(path), instructions: [], loaded: false };
      this.cache.set(path, entry);
    }
    if (listing && !entry.loaded) {
      Object.assign(entry, directories(path), { instructions: instructions(path), loaded: true });
    }
    return entry;
  }
  private prepare() {
    this.snapshot(dirname(this.current));
    for (const row of this.rows) this.snapshot(row.path, false);
    this.snapshot(this.rows[this.selected]?.path ?? this.current);
  }
  private current: string;
  private recents: RecentFolder[];
  private theme: Pick<Theme, "fg" | "bg" | "bold">;
  private firstScreen = true;
  private filter = "";
  private selected = 0;
  private rows: Row[] = [];
  private error?: string;
  private choose: (path: string) => void;
  private cancel: () => void;
  private height: () => number;
  constructor(options: { theme: Pick<Theme, "fg" | "bg" | "bold">; recent?: RecentFolder[]; cwd?: string; onChoose: (path: string) => void; onCancel: () => void; height?: () => number }) {
    this.current = resolve(options.cwd ?? process.cwd());
    this.theme = options.theme;
    const recent = (options.recent ?? []).map(folder => ({ ...folder, path: resolve(folder.path) }));
    this.recents = recent.some(folder => folder.path === this.current) ? recent : [...recent, { path: this.current, agents: 0, at: 0, running: false }];
    this.choose = options.onChoose; this.cancel = options.onCancel; this.height = options.height ?? (() => 18);
    this.load();
  }
  private load() {
    const listing = this.snapshot(this.current);
    this.error = listing.error;
    const query = this.filter.toLowerCase();
    this.rows = [
      ...(this.firstScreen ? this.recents.filter(folder => folder.path.toLowerCase().includes(query)).map(folder => ({ path: folder.path, label: clean(basename(folder.path) || folder.path), recent: folder })) : []),
      ...(!query || query === "." ? [{ path: this.current, label: ".  (choose current directory)" }] : []),
      ...listing.names.filter(name => (query.startsWith(".") || !name.startsWith(".")) && name.toLowerCase().includes(query)).map(name => ({ path: join(this.current, name), label: `${clean(name)}/` })),
    ];
    this.selected = Math.max(0, Math.min(this.selected, this.rows.length - 1));
    this.prepare();
  }
  private navigate(path: string) {
    this.current = path; this.firstScreen = false; this.filter = ""; this.selected = 0; this.load();
  }
  handleInput(data: string) {
    const row = this.rows[this.selected];
    if (data.startsWith("\x1b[200~") && data.endsWith("\x1b[201~")) {
      const path = data.slice(6, -6).trim();
      try { if (statSync(path).isDirectory()) this.navigate(resolve(path)); } catch { /* ignore non-path pastes */ }
      return;
    }
    if (matchesKey(data, Key.escape)) return this.cancel();
    if (matchesKey(data, Key.enter)) {
      if (!row) return;
      const path = row.path;
      try { if (!statSync(path).isDirectory()) throw new Error("Not a directory"); this.choose(path); }
      catch (error) { this.error = errorText(error); }
      return;
    }
    if (matchesKey(data, Key.up)) this.selected = Math.max(0, this.selected - 1);
    else if (matchesKey(data, Key.down)) this.selected = Math.min(this.rows.length - 1, this.selected + 1);
    else if (matchesKey(data, Key.right)) { if (row) this.navigate(row.path); }
    else if (matchesKey(data, Key.left)) this.navigate(dirname(this.current));
    else if (matchesKey(data, Key.backspace)) { this.filter = [...this.filter].slice(0, -1).join(""); this.selected = 0; this.load(); }
    else if (data && !/[\x00-\x1f\x7f]/.test(data)) { this.filter += data; this.selected = 0; this.load(); }
    this.prepare();
  }
  render(width: number): string[] {
    width = Math.max(0, width);
    const fit = (text: string, size = width) => truncateToWidth(text, size, size > 0 ? "…" : "");
    const leftPath = (path: string) => {
      const text = clean(path);
      if (visibleWidth(text) <= width) return text;
      let tail = [...text];
      while (tail.length && visibleWidth(`…${tail.join("")}`) > width) tail.shift();
      return fit(`…${tail.join("")}`);
    };
    const t = this.theme;
    const recents = this.rows.filter(item => item.recent).length;
    // The first screen spends two lines on its "Recent" and "Browse" headings.
    const count = Math.max(1, Math.min(12, this.height() - 5 - (recents ? 2 : 0)));
    const start = Math.max(0, this.selected - count + 1);
    const row = this.rows[this.selected];
    const now = Date.now();
    const line = (item: Row) => {
      const marks = this.cache.get(item.path)!.markers;
      const tags = marks ? `  ${t.fg("muted", marks)}` : "";
      const folder = item.recent;
      if (!folder) return item.label.endsWith("/") ? t.fg("accent", item.label) + tags : t.fg("dim", item.label) + tags;
      const use = folder.agents ? `${folder.agents} agent${folder.agents === 1 ? "" : "s"} · ${folder.running ? "now" : formatAgo(now - folder.at)}` : "current folder";
      return `${t.fg(folder.running ? "success" : "accent", "●")} ${t.bold(item.label)}  ${t.fg("dim", `${use} · ${clean(home(folder.path))}`)}${tags}`;
    };
    const items = this.rows.slice(start, start + count).map((item, i) => ({ text: `${start + i === this.selected ? t.fg("accent", "›") : " "} ${line(item)}`, selected: start + i === this.selected, item }));
    const current: { text: string; selected?: boolean }[] = [];
    for (const [i, entry] of items.entries()) {
      if (recents && entry.item.recent && (i === 0 || !items[i - 1]!.item.recent)) current.push({ text: t.fg("dim", " Recent · last 7 days") });
      if (recents && !entry.item.recent && (i === 0 || items[i - 1]!.item.recent)) current.push({ text: t.fg("dim", ` Browse · ${clean(home(this.current))}`) });
      current.push(entry);
    }
    if (!current.length) current.push({ text: t.fg("dim", "  (no matching directories)") });
    const band = (entry: { text: string; selected?: boolean }, size: number) => {
      const text = fit(entry.text, size);
      const padded = text + " ".repeat(Math.max(0, size - visibleWidth(text)));
      return entry.selected ? t.bg("selectedBg", padded) : padded;
    };
    let body = current.map(entry => band(entry, width));
    if (width >= 100) {
      const parent = dirname(this.current);
      const siblings = this.cache.get(parent)!;
      const index = siblings.names.filter(name => !name.startsWith(".")).indexOf(basename(this.current));
      const parentLines = [t.fg("dim", "Parent"), ...siblings.names.filter(name => !name.startsWith(".")).slice(Math.max(0, index - Math.floor(count / 2)), Math.max(0, index - Math.floor(count / 2)) + count - 1).map(name => `${join(parent, name) === this.current ? "›" : " "} ${clean(name)}/`), ...(siblings.error ? [siblings.error] : [])];
      const preview = row?.path ?? this.current;
      const listing = this.cache.get(preview)!;
      const previewLines = [t.fg("dim", "Preview · ") + t.bold(clean(basename(preview))), t.fg("muted", listing.markers), ...(listing.error ? [listing.error] : (listing.names.filter(name => !name.startsWith(".")).length ? listing.names.filter(name => !name.startsWith(".")).slice(0, 5).map(name => `  ${clean(name)}/`) : ["(empty directory)"])), ...listing.instructions];
      const sizes = [Math.floor((width - 6) * .24), Math.floor((width - 6) * .40)];
      sizes.push(width - 6 - sizes[0]! - sizes[1]!);
      const columns = [parentLines.map(text => ({ text })), [{ text: t.fg("dim", "Current · enter chooses") }, ...current], previewLines.map(text => ({ text }))];
      body = Array.from({ length: Math.min(count + 1 + (recents ? 2 : 0), Math.max(...columns.map(col => col.length))) }, (_, i) => columns.map((col, n) => band(col[i] ?? { text: "" }, sizes[n]!)).join(t.fg("dim", " │ ")));
    }
    return [t.bold(leftPath(this.current)), this.filter ? `Filter: ${t.fg("accent", clean(this.filter))}` : t.fg("dim", "Filter: (type to filter)"), ...body,
      ...(this.error ? [t.fg("error", clean(this.error))] : []),
      t.fg("dim", "↑↓ move · → enter · ← parent"),
      t.fg("dim", "enter choose · esc back")].map(line => fit(line));
  }
  invalidate() {}
}
