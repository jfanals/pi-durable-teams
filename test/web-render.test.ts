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

test("pane rails fold other teams, expose the open team and highlight the path safely", async () => {
  const { paneRails, panePath } = await import("../src/web/render.ts");
  const agent = (id: string, children: import("../src/web/api.ts").Agent[] = []): import("../src/web/api.ts").Agent => ({ id, name: id, hosted: true, children });
  const agents = [agent("main<tag>", [agent("idle"), { ...agent("busy"), running: true }]), agent("other", [agent("folded")])];
  const stack = ["main<tag>", "busy"];
  const rails = paneRails(agents, stack);
  assert.match(rails.dashboard, /main&lt;tag&gt;/);
  // Idle sub-agents fold into the summary everywhere, the open agent too; its column lists them after a click.
  assert.doesNotMatch(rails.dashboard + rails.main, /data-open="idle"/);
  assert.match(rails.dashboard, /data-open="busy"/);
  assert.doesNotMatch(rails.dashboard, /data-open="folded"/);
  assert.equal((rails.dashboard.match(/1 idle/g) ?? []).length, 2);
  assert.match(rails.main, /data-action="idle"[^>]*>1 idle/);
  assert.match(paneRails(agents, stack, true).main, /data-open="idle"/);
  assert.equal((rails.dashboard.match(/aria-current="true"/g) ?? []).length, 2);
  assert.match(rails.main, /data-depth="1"/);
  assert.match(rails.main, /◌/);
  const path = panePath(agents, stack);
  assert.match(path, /data-depth="0"/);
  assert.match(path, /data-depth="1"/);
  assert.match(path, /id="title">busy/);
  assert.doesNotMatch(path + rails.dashboard + rails.main, /<tag>/);
  // The mark: ◌ running, ● a reply not yet opened (white), ○ seen. Agents idle for over a day sit below a divider.
  const day = 86_400_000, now = Date.now();
  const recent = [{ ...agent("fresh"), unread: true, finishedAt: now - 1000 }, { ...agent("stale"), finishedAt: now - 2 * day }];
  const dash = paneRails(recent, []).dashboard;
  assert.match(dash, /class="tone-unread">●<\/span>[\s\S]*idle over 24h[\s\S]*class="tone-idle">○<\/span>/);
  assert.equal((paneRails([recent[0]!], []).dashboard.match(/divider/g) ?? []).length, 0, "no divider when every agent is recent");
  // Waiting on you: an amber count before the name; each ask jumps to its reply and carries its "Re:" line.
  const { asksBar } = await import("../src/web/render.ts");
  const asking = { ...agent("lead"), asks: [{ title: "URLs <b>", text: "(a) or (b)?", entry: "42", at: Date.now() - 7_200_000 }] };
  assert.match(paneRails([asking], ["lead"]).dashboard, /class="ask-count"[^>]*>1<\/span> lead/);
  assert.match(panePath([asking], ["lead"]), /id="title"><span class="ask-count"/);
  // Answered in the unsent draft (chat.ts withDraft, as every view draws the roster): no count, no longer yellow.
  const { withDraft } = await import("../src/chat.ts");
  const drafted = paneRails([withDraft(asking, "Re: URLs <b> — (a)")], ["lead"]).dashboard;
  assert.doesNotMatch(drafted, /ask-count|tone-ask/); assert.match(paneRails([withDraft(asking, "Re: other — x")], ["lead"]).dashboard, /tone-ask/);
  assert.match(asksBar(asking), /data-ask="42" data-title="URLs &lt;b&gt;"[^>]*>URLs &lt;b&gt;: \(a\) or \(b\)\? <small>2h ago<\/small>/);
  // Its options are buttons that carry the ask and the option for the "Re:" line.
  const options = asksBar({ ...asking, asks: [{ ...asking.asks[0]!, options: ["Keep <a>", "Drop"] }] });
  assert.match(options, /class="ask-options"><button [^>]*data-ask="42" data-title="URLs &lt;b&gt;" data-option="Keep &lt;a&gt;"[^>]*>Keep &lt;a&gt;<\/button><button [^>]*data-option="Drop"/);
  assert.match(transcript([{ id: "42", kind: "reply", parts: [{ type: "text", text: "- [ ] **URLs**: ?" }] }]), /data-entry="42"/);
  assert.equal(asksBar(agent("quiet")), "");
});
