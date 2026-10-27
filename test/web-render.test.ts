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
    { type: "image", mimeType: "image/png", data: "aGVsbG8=" },
  ] }]), /<img class="attachment" alt="Attached image" src="data:image\/png;base64,aGVsbG8=">/);
  const thoughts = transcript([{ id: "2", kind: "reply", parts: [
    { type: "thinking", text: "one" }, { type: "thinking", text: "two" },
  ] }]);
  assert.match(thoughts, /data-thinking="2-0"/);
  assert.match(thoughts, /data-thinking="2-1"/);
});
