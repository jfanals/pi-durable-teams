import assert from "node:assert/strict";
import { test } from "node:test";
import { markdown, transcript } from "../src/web/render.ts";

test("web markdown escapes HTML, drops unsafe URLs and images, and keeps HTTP links", () => {
  assert.match(markdown('<script>alert(1)</script>'), /&lt;script&gt;/);
  assert.doesNotMatch(markdown('[bad](javascript:alert%281%29) [bad](data:text/html,hello)'), /href=/);
  assert.equal(markdown('![only alt](https://example.com/p.png)').trim(), '<p>only alt</p>');
  assert.match(markdown('[safe](https://example.com)'), /href="https:\/\/example.com"/);
  assert.match(markdown('[safe](http://example.com)'), /href="http:\/\/example.com"/);
  const html = transcript([{ id: "1", kind: "input", from: "Lead", text: "**bold**\nnext" }]);
  assert.match(html, /<strong>bold<\/strong><br>/);
  assert.match(transcript([{ id: "image", kind: "input", from: "Human", text: "", images: [
    { mimeType: "image/png" },
  ] }]), /\[image\]/);
  assert.doesNotMatch(html, /data-rewind/);
  assert.match(transcript([{ id: "human", kind: "input", from: "Human", text: "hello" }]), /data-rewind="human"/);
  assert.doesNotMatch(transcript([{ id: "report", kind: "input", from: "Human", report: true, text: "report" }]), /data-rewind/);
  const thoughts = transcript([{ id: "2", kind: "reply", parts: [
    { type: "thinking", text: "one" }, { type: "thinking", text: "two" },
  ] }]);
  assert.match(thoughts, /data-rewind="2"/);
  assert.match(thoughts, /<div class="thinking markdown"><p>one<\/p>\n<\/div><div class="thinking markdown"><p>two<\/p>/);
});


test("generic tool cards preserve full args, results and lazy result images with safe stable identities", () => {
  const prompt = "first line\nlast line <script>";
  const html = transcript([
    { id: "1", kind: "reply", parts: [
      { type: "tool", id: "spawn", name: "team", subject: "spawn reader", args: { action: "spawn", message: prompt } },
      { type: "tool", id: "shell", name: "bash", subject: "echo", args: { command: "echo one\necho two" } },
      { type: "tool", id: "read", name: "read", subject: "image.png", args: { path: "image.png" } },
    ] },
    { id: "2", kind: "result", callId: "spawn", ok: true, content: [{ type: "text", text: "accepted <tag>" }] },
    { id: "3", kind: "result", callId: "read", ok: false, error: "error <tag>", content: [
      { type: "text", text: "image result" }, { type: "image", mimeType: "image/png" },
    ] },
    { id: "4", kind: "compaction", summary: "summary", tokensBefore: 100 },
  ]);
  assert.equal((html.match(/<details class="tool /g) ?? []).length, 3);
  assert.match(html, /data-card="tool:spawn"/);
  assert.match(html, /first line\nlast line &lt;script&gt;/);
  assert.match(html, /<pre>echo one\necho two<\/pre>/);
  assert.match(html, /&quot;path&quot;:&quot;image.png&quot;/);
  assert.match(html, /accepted &lt;tag&gt;/);
  assert.match(html, /image result/);
  assert.match(html, /error &lt;tag&gt;/);
  assert.match(html, /data-images="3"/);
  assert.doesNotMatch(html, /data-images="read"|<script>|<tag>/);
  assert.match(html, /data-card="compaction:4"/);
});
