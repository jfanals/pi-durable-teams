import { existsSync, openSync, readSync, closeSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { Key, matchesKey, stripTerminalSequences, truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";

const clean = (text: string) => stripTerminalSequences(text).replace(/[\x00-\x1f\x7f]/g, " ");
const errorText = (error: unknown) => `Cannot read: ${error instanceof Error ? error.message : String(error)}`;
function directories(path: string, hidden = false): { names: string[]; error?: string } {
  try {
    const names = readdirSync(path, { withFileTypes: true }).filter(entry => {
      if (entry.name === "node_modules" || (!hidden && entry.name.startsWith("."))) return false;
      try { return entry.isDirectory() || (entry.isSymbolicLink() && statSync(join(path, entry.name)).isDirectory()); } catch { return false; }
    }).map(entry => entry.name).sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()) || a.localeCompare(b));
    return { names };
  } catch (error) { return { names: [], error: errorText(error) }; }
}
function markers(path: string) {
  return [existsSync(join(path, ".git")) && "git", existsSync(join(path, "AGENTS.md")) && "AGENTS.md",
    (existsSync(join(path, ".pi", "skills")) || existsSync(join(path, "skills", "SKILL.md"))) && "skills"].filter(Boolean).join(" · ");
}
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
type Row = { path: string; label: string; recent?: boolean };

/** Local filesystem for now: a phone client would need a host route instead. */
export class DirPicker implements Component {
  private current: string;
  private recents: string[];
  private firstScreen = true;
  private filter = "";
  private selected = 0;
  private rows: Row[] = [];
  private error?: string;
  private choose: (path: string) => void;
  private cancel: () => void;
  private height: () => number;
  constructor(options: { recent?: string[]; cwd?: string; onChoose: (path: string) => void; onCancel: () => void; height?: () => number }) {
    this.current = resolve(options.cwd ?? process.cwd());
    this.recents = [...new Set([...(options.recent ?? []), this.current].map(path => resolve(path)))];
    this.choose = options.onChoose; this.cancel = options.onCancel; this.height = options.height ?? (() => 18);
    this.load();
  }
  private load() {
    const listing = directories(this.current, this.filter.startsWith("."));
    this.error = listing.error;
    const query = this.filter.toLowerCase();
    this.rows = [
      ...(this.firstScreen ? this.recents.filter(path => path.toLowerCase().includes(query)).map(path => ({ path, label: `Recent · ${clean(basename(path) || path)} — ${clean(path)}`, recent: true })) : []),
      ...(!query || query === "." ? [{ path: this.current, label: ".  (choose current directory)" }] : []),
      ...listing.names.filter(name => name.toLowerCase().includes(query)).map(name => ({ path: join(this.current, name), label: `${clean(name)}/` })),
    ];
    this.selected = Math.max(0, Math.min(this.selected, this.rows.length - 1));
  }
  private navigate(path: string) {
    this.current = path; this.firstScreen = false; this.filter = ""; this.selected = 0; this.load();
  }
  handleInput(data: string) {
    const row = this.rows[this.selected];
    if (matchesKey(data, Key.escape)) return this.cancel();
    if (matchesKey(data, Key.enter)) {
      if (!row) return;
      const path = row.path;
      try { if (!statSync(path).isDirectory()) throw new Error("Not a directory"); this.choose(path); }
      catch (error) { this.error = errorText(error); }
      return;
    }
    if (matchesKey(data, Key.up) || data === "k") this.selected = Math.max(0, this.selected - 1);
    else if (matchesKey(data, Key.down) || data === "j") this.selected = Math.min(this.rows.length - 1, this.selected + 1);
    else if (matchesKey(data, Key.right) || data === "l") { if (row) this.navigate(row.path); }
    else if (matchesKey(data, Key.left) || data === "h") this.navigate(dirname(this.current));
    else if (data === "~") this.navigate(homedir());
    else if (matchesKey(data, Key.backspace)) { this.filter = [...this.filter].slice(0, -1).join(""); this.selected = 0; this.load(); }
    else if (data && !/[\x00-\x1f\x7f]/.test(data)) { this.filter += data; this.selected = 0; this.load(); }
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
    const count = Math.max(1, Math.min(12, this.height() - 5));
    const start = Math.max(0, this.selected - count + 1);
    const row = this.rows[this.selected];
    const current = this.rows.slice(start, start + count).map((item, i) => `${start + i === this.selected ? "›" : " "} ${item.label}  ${markers(item.path)}`);
    if (!current.length) current.push("  (no matching directories)");
    let body = current;
    if (width >= 100) {
      const parent = dirname(this.current);
      const siblings = directories(parent);
      const index = siblings.names.indexOf(basename(this.current));
      const parentLines = ["Parent", ...siblings.names.slice(Math.max(0, index - Math.floor(count / 2)), Math.max(0, index - Math.floor(count / 2)) + count - 1).map(name => `${join(parent, name) === this.current ? "›" : " "} ${clean(name)}/`), ...(siblings.error ? [siblings.error] : [])];
      const preview = row?.path ?? this.current;
      const listing = directories(preview);
      const previewLines = ["Preview · " + clean(basename(preview)), markers(preview), ...(listing.error ? [listing.error] : (listing.names.length ? listing.names.slice(0, 5).map(name => `  ${clean(name)}/`) : ["(empty directory)"])), ...instructions(preview)];
      const sizes = [Math.floor((width - 6) * .24), Math.floor((width - 6) * .40)];
      sizes.push(width - 6 - sizes[0]! - sizes[1]!);
      const columns = [parentLines, ["Current · enter chooses", ...current], previewLines];
      body = Array.from({ length: Math.min(count + 1, Math.max(...columns.map(col => col.length))) }, (_, i) => columns.map((col, n) => {
        const text = fit(col[i] ?? "", sizes[n]);
        return text + " ".repeat(Math.max(0, sizes[n]! - visibleWidth(text)));
      }).join(" │ "));
    }
    return [leftPath(this.current), `Filter: ${clean(this.filter) || "(type to filter)"}`, ...body,
      ...(this.error ? [clean(this.error)] : []),
      "↑↓/jk move · →/l enter · ←/h parent",
      "enter choose · ~ home · esc back"].map(line => fit(line));
  }
  invalidate() {}
}
