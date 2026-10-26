import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, dirname } from "node:path";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { DirPicker } from "../src/dir-picker.ts";

test("directory picker browses, filters, previews and chooses directories at every width", () => {
  const root = mkdtempSync(join(tmpdir(), "dir-picker-"));
  try {
    for (const name of ["Alpha/.git", "Alpha/skills", "Alpha/child", "beta", ".hidden", "node_modules"]) mkdirSync(join(root, name), { recursive: true });
    writeFileSync(join(root, "Alpha/AGENTS.md"), "# Project instructions\nUse public exports.\n");
    writeFileSync(join(root, "Alpha/skills/SKILL.md"), "skill");
    writeFileSync(join(root, "file.txt"), "not a directory");
    const chosen: string[] = []; let cancelled = false;
    const picker = new DirPicker({ cwd: root, recent: [join(root, "beta"), root, root], onChoose: path => chosen.push(path), onCancel: () => { cancelled = true; } });
    const screen = (width = 120) => picker.render(width).join("\n");
    let wide = screen();
    assert.equal(wide.split("\n").filter(line => line.includes("Recent ·")).length, 2);
    assert.match(wide, /Parent.*Current.*Preview/);
    assert.match(wide, /Alpha\/.*git · AGENTS.md · skills/);
    assert.doesNotMatch(wide, /node_modules|file.txt|\.hidden/);
    assert.doesNotMatch(screen(60), /Parent|Preview|│/);
    picker.handleInput("\r"); assert.equal(chosen.pop(), join(root, "beta"));
    picker.handleInput("Al");
    assert.match(screen(), /Filter: Al/);
    assert.doesNotMatch(screen(), /Recent ·/);
    assert.match(screen(), /Project instructions/);
    picker.handleInput("l"); assert.ok(screen().startsWith(join(root, "Alpha")));
    assert.match(screen(), /Filter: \(type to filter\)/);
    picker.handleInput("\r"); assert.equal(chosen.pop(), join(root, "Alpha"));
    picker.handleInput("h"); assert.ok(screen().startsWith(root));
    picker.handleInput("."); assert.match(screen(), /\.hidden\//);
    picker.handleInput("\x7f"); assert.doesNotMatch(screen(), /\.hidden\//);
    picker.handleInput("j"); picker.handleInput("k"); picker.handleInput("\r"); assert.equal(chosen.pop(), root);
    picker.handleInput("beta"); picker.handleInput("\x1b[C");
    assert.ok(screen().startsWith(join(root, "beta")));
    picker.handleInput("\r"); assert.equal(chosen.pop(), join(root, "beta"));
    for (let width = 0; width <= 150; width++) assert.ok(picker.render(width).every(line => visibleWidth(line) <= width), `width ${width}`);
    picker.handleInput("\x1b[D"); assert.ok(screen().startsWith(root));
    picker.handleInput("~"); assert.ok(screen().startsWith(homedir()));
    picker.handleInput("\x1b"); assert.equal(cancelled, true);
    const missing = new DirPicker({ cwd: join(root, "missing"), onChoose: () => assert.fail("must not choose missing directory"), onCancel() {} });
    assert.match(missing.render(120).join("\n"), /Cannot read/);
    missing.handleInput("\r"); assert.match(missing.render(120).join("\n"), /Cannot read/);
    assert.notEqual(dirname(root), root);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
