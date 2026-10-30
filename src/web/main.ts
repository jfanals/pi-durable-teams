import { attachAutocomplete } from "./autocomplete.ts";
import type { ImageContent } from "@earendil-works/pi-ai";
import { notifications, notificationState, toggleNotifications } from "./push.ts";
import { api, mutate, stream, token, unpair, type Agent, type Page, type Model } from "./api.ts";
import { escape as e, askCount, asksBar, info, footerInfo, transcript, paneRails, panePath } from "./render.ts";
import { archiveView, formatCost, formatDuration, recentFolders, statusTone, statusWord, teamGlance } from "../status.ts";
import { modelThinking, modelNotice, thinkingSelection } from "../model-selection.ts";
import { NEW, agentNameError, suggestedAgentName } from "../agent-name.ts";
import { withReply, type ChatItem } from "../chat.ts";
import type { WorkerModel } from "../config.ts";

const root = document.querySelector<HTMLElement>("#app")!;
let agents: Agent[] = [];
let stack: string[] = [];
let items: ChatItem[] = [];
let next: string | undefined;
let conversationId: string | undefined;
let screen = "list";
let rosterLife = new AbortController();
let watchLife = new AbortController();
let refreshing = false;
let dirty = false;
let generation = 0;
/** What the human just started and the host has not finished: shown at once in the working line. */
let pending = "";
let attachments: ImageContent[] = [];
const imageCache = new Map<string, Promise<ImageContent[]>>();
const reconnecting = new Set<string>();
const all = (): Agent[] => agents.flatMap((a) => [a, ...a.children]);
const current = () => all().find((a) => a.id === stack.at(-1));
const button = (label: string, action: string, extra = "") =>
  `<button data-action="${action}" ${extra}>${label}</button>`;
function banner(key: string, retrying: boolean) {
  if (retrying) reconnecting.add(key);
  else reconnecting.delete(key);
  const el = document.querySelector<HTMLElement>("#connection");
  if (el) {
    el.hidden = !reconnecting.size;
    el.textContent = "Host disconnected — reconnecting…";
  }
}
function notice(text: string) {
  const el = document.querySelector("#notice");
  if (el) el.textContent = text;
}
function fail(error: unknown) {
  const el = document.querySelector<HTMLElement>("#error");
  if (el) el.textContent = error instanceof Error ? error.message : String(error);
}
let direction = "forward";
function base(content: string) {
  root.className = `${screen === "chat" ? "chat-screen" : ""} ${direction}`;
  root.innerHTML = `<div id="connection" role="status" ${reconnecting.size ? "" : "hidden"}>
Host disconnected — reconnecting…</div>${content}<div id="notice" role="status"></div><div id="error" role="alert"></div>`;
}
/** The list shows active agents or, toggled, archived ones; `agents` stays the host's full roster. */
let showArchived = false;
/** The open agent's idle sub-agents, listed in its column after a click on their summary line. */
let showIdle = false;
function list() {
  const scroll = document.querySelector(".list")?.scrollTop ?? 0;
  const focus = (document.activeElement as HTMLElement)?.dataset.open;
  screen = "list";
  // Each agent's team at a glance, as in the terminal: running sub-agents get a row;
  // the rest fold into one summary line, listed when the agent is opened.
  const team = (a: Agent): string => {
    if (!a.children.length) return "";
    const { shown, summary } = teamGlance(a.children);
    return shown.map((w) => row(a.children.find((c) => c.id === w.id)!, true)).join("")
      + (summary ? `<div class="team-summary">${e(summary)}</div>` : "");
  };
  const row = (a: Agent, child = false): string =>
    `<button class="agent ${child ? "child" : ""}" data-open="${e(a.id)}">
<div class="row">
<strong class="${a.running || a.unread ? "" : "read"}">${askCount(a)}${e(a.name)}</strong>
<span class="tone-${statusTone(a)}">${a.running ? '<i class="spinner"></i>' : ""}${e(statusWord(a))}</span>
</div>
<small data-time="${e(a.id)}">${e(info(a))}</small>
</button>${child ? "" : team(a)}`;
  const view = archiveView(agents, showArchived);
  if (!view.archivedCount) showArchived = false;
  const shown = showArchived ? view.agents : archiveView(agents, false).agents;
  const running = shown.filter((a) => a.running).length;
  const totalCost = formatCost(all().reduce((n, a) => n + (a.cost ?? 0), 0)) || "$0.000";
  const subscription = all().some((a) => a.subscription) ? " (sub)" : "";
  base(
    `<header>
<h1>Pi Agents</h1>${button("+", "new", 'aria-label="New agent"')}</header>
<section class="notification-setting">
<label><input type="checkbox" id="notify" ${notifications.enabled ? "checked" : ""} ${notifications.busy || !notifications.supported ? "disabled" : ""}> Notify when agents finish</label>
<small role="status">${e(notifications.note)}</small></section>
<main class="list">${shown.map((a) => row(a)).join("") || '<p class="notice">No agents yet. Tap + to create one.</p>'}</main>
<footer>
<small>${showArchived ? `${shown.length} archived` : `${running} running · ${shown.length - running} idle · total ${totalCost}${subscription}`}</small>
${view.archivedCount ? button(showArchived ? "Active agents" : `Archived (${view.archivedCount})`, "archived") : ""}
</footer>`,
  );
  document.querySelector(".list")!.scrollTop = scroll;
  const focused = [...root.querySelectorAll<HTMLElement>("[data-open]")].find(
    (el) => el.dataset.open === focus,
  );
  focused?.focus({ preventScroll: true });
}
function status(clockOnly = false) {
  const a = current();
  if (!a || screen !== "chat" || !document.querySelector("#path")) return;
  if (!clockOnly) {
    document.querySelector("#path")!.innerHTML = panePath(agents, stack);
    const rails = paneRails(agents, stack, showIdle);
    document.querySelector(".rail.dash")!.innerHTML = rails.dashboard;
    document.querySelector(".rail.main")!.innerHTML = rails.main;
    document.querySelector("#status")!.textContent = statusWord(a);
    document.querySelector("#info")!.textContent = footerInfo(a);
    document.querySelector("#asks")!.innerHTML = asksBar(a);
  }
  document.querySelector("#working")!.textContent = pending || (a.running
    ? `${a.activity ?? "working"} · ${a.since ? formatDuration(Date.now() - a.since) : ""}`
    : "");
  if (clockOnly) return;
  (document.querySelector("#stop") as HTMLButtonElement).hidden = !a.running;
  document.querySelector("#children")!.innerHTML = a.children.filter((c) => a.archived || !c.archived)
    .map((c) => `<button data-open="${e(c.id)}">${c.running ? "◌ " : ""}${e(c.name)}</button>`)
    .join("");
}
async function open(id: string, push = true) {
  if (!stack.length || stack[0] !== id && !agents.find(a => a.id === stack[0])?.children.some(c => c.id === id)) showIdle = false;
  attachments = [];
  imageCache.clear();
  if (push) {
    direction = "forward";
    // A sub-agent opened from the list goes back to its main agent, not the list, as in the terminal.
    const parent = stack.length ? undefined : agents.find((a) => a.children.some((c) => c.id === id));
    if (parent) {
      stack.push(parent.id);
      history.pushState({ stack: [...stack], screen: "chat" }, "", `/#agent=${encodeURIComponent(parent.id)}`);
    }
    stack.push(id);
    history.pushState({ stack: [...stack], screen: "chat" }, "", `/#agent=${encodeURIComponent(id)}`);
  }
  screen = "chat";
  items = [];
  next = undefined;
  generation++;
  watchLife.abort();
  base(
    `<div class="panes depth-${stack.length}"><nav class="rail dash" aria-label="Dashboard"></nav><nav class="rail main" aria-label="Main agent"></nav><section class="pane">
<header>${button("‹", "back", 'aria-label="Back"')}<div class="heading">
<h1 id="path"></h1>
<small id="status">
</small>
</div>${button("⋮", "menu", 'aria-label="Agent menu"')}</header>
<section id="messages" aria-label="Transcript">
<div id="history">
</div>
</section>
<div id="children" class="chips">
</div>
<footer class="composer-footer">
<button id="new-messages" hidden data-action="bottom">New messages ↓</button>
<div id="asks" class="asks"></div>
<div id="queued" class="queued"></div>
<div id="working" role="status">
</div>
<small id="info">
</small>
<form id="composer">
<textarea id="message" rows="2" placeholder="Message agent…" aria-label="Message">
</textarea>
<div id="attachments"></div>
<label class="attach">Attach image<input id="attach" type="file" accept="image/png,image/jpeg,image/gif,image/webp" multiple></label>
<div class="row">
<label>
<input id="steer" type="checkbox"> Steer</label>
${button("Model & thinking", "model", 'type="button"')}
<div>${button("Stop", "stop", 'id="stop" type="button" hidden')}<button type="submit">Send</button>
</div>
</div>
</form>
</footer></section></div>`,
  );
  const message = document.querySelector<HTMLTextAreaElement>("#message")!;
  // Unsent prompts are kept per agent in this browser, across panes and closed tabs.
  message.value = localStorage.getItem(`draft:${id}`) ?? "";
  message.addEventListener("input", () => saveDraft(id, message.value));
  attachAutocomplete(message, id);
  document.querySelector("#messages")!.addEventListener("scroll", () => {
    const view = document.querySelector("#messages");
    if (!view) return; // A queued scroll event can outlive a collapsed pane.
    if (view.scrollHeight - view.scrollTop - view.clientHeight < 70)
      (document.querySelector("#new-messages") as HTMLElement).hidden = true;
    // As in the terminal: nearing the top loads the previous page, so scrolling reaches the first message.
    if (view.scrollTop < 300) void older().catch(fail);
  });
  status();
  await refresh();
  startWatch();
}
function drawChat(older = false) {
  const view = document.querySelector<HTMLElement>("#messages");
  if (!view) return;
  const bottom = view.scrollHeight - view.scrollTop - view.clientHeight < 70;
  const height = view.scrollHeight;
  const top = view.scrollTop;
  const expanded = [...view.querySelectorAll<HTMLDetailsElement>("details[open]")].map(
    (el) => el.dataset.card,
  );
  document.querySelector("#history")!.innerHTML =
    `${next ? button("Load older", "older") : ""}${transcript(items) || '<p class="notice">Send a message to get started.</p>'}`;
  const target = stack.at(-1)!;
  view.querySelectorAll<HTMLElement>("[data-images]").forEach(el => {
    const entryId = el.dataset.images!;
    const key = `${target}:${conversationId}:${entryId}`;
    let images = imageCache.get(key);
    if (!images) {
      images = api<ImageContent[]>("/images", { target, entryId });
      imageCache.set(key, images);
    }
    void images.then(images => {
      if (!el.isConnected) return;
      el.replaceChildren(...images.map(image => {
        const img = document.createElement("img");
        img.className = "attachment"; img.alt = "Attached image";
        img.src = `data:${image.mimeType};base64,${image.data}`;
        return img;
      }));
    }).catch(() => { imageCache.delete(key); });
  });
  view.querySelectorAll<HTMLDetailsElement>("details").forEach((el) => {
    el.open = expanded.includes(el.dataset.card);
  });
  if (older) view.scrollTop = top + view.scrollHeight - height;
  else if (bottom) view.scrollTop = view.scrollHeight;
  else (document.querySelector("#new-messages") as HTMLElement).hidden = false;
}
let loadingOlder = false;
async function older() {
  if (!next || loadingOlder) return;
  loadingOlder = true;
  try {
    const version = generation;
    const page = await api<Page>("/page", { target: stack.at(-1), cursor: next });
    if (version !== generation) return;
    const merged = new Map([...page.items, ...items].map((item) => [item.id, item]));
    items = [...merged.values()];
    next = page.next;
    drawChat(true);
  } finally { loadingOlder = false; }
}
function saveDraft(id: string, text: string) {
  if (text.trim()) localStorage.setItem(`draft:${id}`, text); else localStorage.removeItem(`draft:${id}`);
}
/** An ask: add its "Re:" line to the draft, with `option` when one was picked (replacing an earlier pick),
 * and centre the line it was asked on, usually at the end of its reply (loading older pages if needed). */
async function answer(entry: string, title: string, option?: string) {
  const input = document.querySelector<HTMLTextAreaElement>("#message")!;
  if (option !== undefined) input.value = withReply(input.value, { title }, option);
  else if (!input.value.includes(`Re: ${title} — `)) input.value = withReply(input.value, { title }, "");
  saveDraft(stack.at(-1)!, input.value);
  input.focus(); input.setSelectionRange(input.value.length, input.value.length);
  const version = generation;
  while (!items.some(item => item.id === entry) && next && version === generation) await older();
  const article = document.querySelector<HTMLElement>(`[data-entry="${CSS.escape(entry)}"]`);
  if (!article) return;
  const line = [...article.querySelectorAll<HTMLElement>("li, p")].reverse().find(el => el.textContent?.includes(title)) ?? article;
  line.scrollIntoView({ block: "center", behavior: "smooth" });
  line.classList.remove("flash"); void line.offsetWidth; line.classList.add("flash");
}
async function refresh() {
  if (refreshing) {
    dirty = true;
    return;
  }
  refreshing = true;
  try {
    do {
      dirty = false;
      const id = stack.at(-1);
      const version = generation;
      const page = await api<Page>("/page", { target: id });
      if (version !== generation || screen !== "chat") continue;
      // Pi's pending-message lines: messages waiting for the agent's next boundary.
      const queued = document.querySelector("#queued");
      if (queued) queued.innerHTML = (page.queued ?? []).map((q) => `<p>${q.mode === "steer" ? "Steering" : "Follow-up"}: ${e(q.text)}</p>`).join("") + (page.queued?.length ? button("Edit queued", "dequeue", 'type="button"') : "");
      if (page.conversationId !== conversationId) { items = []; next = page.next; conversationId = page.conversationId; }
      const overlaps = page.items.some((item) => items.some((old) => old.id === item.id));
      if (!overlaps) {
        items = [];
        next = page.next;
      }
      const merged = new Map(items.map((item) => [item.id, item]));
      for (const item of page.items) merged.set(item.id, item);
      // Preserve loaded history and its cursor while refreshing the newest page.
      if (!items.length) next = page.next;
      const updated = [...merged.values()].sort((a, b) => Number(a.id) - Number(b.id));
      const changed = JSON.stringify(updated) !== JSON.stringify(items);
      items = updated;
      if (changed || !document.querySelector("#history")?.children.length) drawChat();
    } while (dirty);
  } catch (error) {
    fail(error);
  } finally {
    refreshing = false;
  }
}
function startWatch() {
  watchLife.abort();
  watchLife = new AbortController();
  reconnecting.delete("chat");
  if (!document.hidden && screen === "chat")
    void stream(
      "/watch",
      { target: stack.at(-1) },
      watchLife.signal,
      () => void refresh(),
      (retry) => banner("chat", retry),
    );
}
function startRoster() {
  rosterLife.abort();
  rosterLife = new AbortController();
  if (!document.hidden)
    void stream(
      "/roster",
      {},
      rosterLife.signal,
      (rows) => {
        agents = rows;
        if (screen === "list") list();
        else status();
      },
      (retry) => banner("roster", retry),
    );
}
async function modelFields(agent?: Agent) {
  const models = await api<Model[]>("/models");
  if (!models.length) throw new Error("No models available; configure models first");
  const index = Math.max(
    0,
    models.findIndex((m) => m.provider === agent?.provider && m.modelId === agent?.modelId),
  );
  return { models, index };
}
function showDialog(title: string, fields: string, save?: (form: FormData) => Promise<void>) {
  document.querySelector("dialog")?.remove();
  const dialog = document.createElement("dialog");
  dialog.innerHTML = `<form>
<h2>${e(title)}</h2>${fields}<p class="dialog-error" role="alert">
</p>
<div class="row">
<button type="button" data-cancel>Cancel</button>${save ? "<button>Save</button>" : ""}</div>
</form>`;
  document.body.append(dialog);
  dialog.showModal();
  dialog.querySelector("[data-cancel]")!.addEventListener("click", () => dialog.remove());
  dialog.querySelector("form")!.onsubmit = async (event) => {
    event.preventDefault();
    if (!save) return;
    const submit = dialog.querySelector<HTMLButtonElement>('button:not([type="button"])')!;
    submit.disabled = true;
    try {
      await save!(new FormData(dialog.querySelector("form")!));
      dialog.remove();
    } catch (error) {
      dialog.querySelector(".dialog-error")!.textContent =
        error instanceof Error ? error.message : String(error);
    } finally {
      submit.disabled = false;
    }
  };
  return dialog;
}
async function pickModel(agent: Agent) {
  const { models, index } = await modelFields(agent);
  const d = showDialog("Model & thinking", selectors(models, index), async form => {
    const model = models[Number(form.get("model"))]!;
    const level = String(form.get("thinking"));
    await mutate("/model", { target: agent.id, provider: model.provider, modelId: model.modelId, thinking: level });
    notice(modelNotice(model, level));
  });
  thinking(d, models, agent.thinking);
}
function selectors(models: Model[], index: number) {
  const options = models
    .map(
      (m, i) =>
        `<option value="${i}" ${i === index ? "selected" : ""}>${e(m.provider)}/${e(m.modelId)}</option>`,
    )
    .join("");
  return `<label>Model<select name="model" id="model" required>${index < 0 ? '<option value="" selected disabled>Choose a model…</option>' : ""}${options}</select></label>
<label>Thinking<select name="thinking" id="thinking"></select></label>`;
}
function thinking(container: HTMLElement, models: Model[], preferred?: string) {
  const model = container.querySelector<HTMLSelectElement>("#model")!;
  const update = () => {
    const thinking = container.querySelector<HTMLSelectElement>("#thinking")!;
    thinking.disabled = model.value === "";
    if (thinking.disabled) {
      thinking.innerHTML = "";
      return;
    }
    const levels = models[Number(model.value)]!.thinkingLevels;
    const value =
      preferred && levels.includes(preferred) ? preferred : levels.includes("medium") ? "medium" : levels[0];
    container.querySelector("#thinking")!.innerHTML = levels
      .map((level) => `<option ${level === value ? "selected" : ""}>${e(level)}</option>`)
      .join("");
  };
  model.onchange = update;
  update();
}
let folder = "";
let folderRequest = 0;
async function browse(path?: string) {
  const request = ++folderRequest;
  const listing = await api<{
    path: string;
    parent?: string;
    dirs: { name: string; markers: string }[];
    error?: string;
  }>("/dirs", { path });
  if (screen !== "new" || request !== folderRequest) return;
  folder = listing.path;
  const el = document.querySelector("#folders");
  if (!el) return;
  const error = listing.error ? `<p class="error">${e(listing.error)}</p>` : "";
  const parent = listing.parent
    ? `<button type="button" data-dir="${e(listing.parent)}">↑ Parent folder</button>`
    : "";
  const dirs = listing.dirs
    .map((dir) => {
      const path = `${folder.replace(/\/$/, "")}/${dir.name}`;
      return `<button type="button" data-dir="${e(path)}">📁 ${e(dir.name)}
<small>${e(dir.markers)}</small></button>`;
    })
    .join("");
  el.innerHTML = `<label>Working directory<input id="folder" value="${e(folder)}"></label>
${button("Go", "folder-go", 'type="button"')}<div class="directory">${error}${parent}${dirs}</div>`;
}
async function newAgent() {
  screen = "new";
  history.pushState({ screen: "new", stack: [] }, "", "/");
  const version = ++generation;
  watchLife.abort();
  stack = [];
  const recent = recentFolders(agents)
    .map((f) => `<option value="${e(f.path)}">${e(f.path.split("/").pop() || f.path)} — ${f.agents} agent${f.agents === 1 ? "" : "s"} · ${e(f.path)}</option>`)
    .join("");
  let nameEdited = false;
  let draftName = "";
  let draftModel: WorkerModel | null | undefined;
  const review = async (cwd: string) => {
    base(
      `<header>${button("←", "back", 'aria-label="Back"')}<h1>New agent</h1></header>
<main class="new"><p role="status">Loading agent settings…</p></main>`,
    );
    let settings: [{ models: Model[]; index: number }, WorkerModel | null];
    try {
      settings = await Promise.all([modelFields(), api<WorkerModel | null>("/defaults")]);
    } catch (error) {
      if (version !== generation) return;
      base(
        `<header>${button("←", "back", 'aria-label="Back"')}<h1>New agent</h1></header>
<main class="new"><button id="retry-settings">Retry loading settings</button></main>`,
      );
      fail(error);
      document.querySelector<HTMLButtonElement>("#retry-settings")!.onclick = () => {
        void review(cwd);
      };
      return;
    }
    const [{ models }, defaults] = settings;
    if (version !== generation) return;
    const selectedModel = draftModel === undefined ? defaults : draftModel;
    const index = selectedModel ? models.findIndex(
      (m) => m.provider === selectedModel.provider && m.modelId === selectedModel.modelId,
    ) : -1;
    base(
      `<header>${button("←", "back", 'aria-label="Back"')}<h1>New agent</h1></header>
<main class="new"><form id="new-form">
<label>Working directory<input value="${e(cwd)}" readonly></label>
<button type="button" id="change-folder">Change folder</button>
<label>Name<input name="name" required maxlength="64" autocomplete="off" value="${e(nameEdited ? draftName : suggestedAgentName(cwd, agents.map((a) => a.name)))}"></label>
${index < 0 ? '<p>No configured model is available. Choose a model to continue.</p>' : ""}
${selectors(models, index)}<button>Create agent</button>
</form></main>`,
    );
    thinking(root, models, selectedModel?.thinking);
    const nameInput = document.querySelector<HTMLInputElement>('[name="name"]')!;
    nameInput.oninput = () => { nameEdited = true; };
    document.querySelector<HTMLButtonElement>("#change-folder")!.onclick = () => {
      draftName = nameInput.value;
      const form = new FormData(document.querySelector<HTMLFormElement>("#new-form")!);
      const selected = form.get("model");
      const model = selected === null || selected === "" ? undefined : models[Number(selected)];
      draftModel = model ? {
        provider: model.provider, modelId: model.modelId,
        thinking: String(form.get("thinking")) as WorkerModel["thinking"],
      } : null;
      void chooseFolder(cwd, cwd).catch(fail);
    };
    document.querySelector<HTMLFormElement>("#new-form")!.onsubmit = async (event) => {
      event.preventDefault();
      const element = event.currentTarget as HTMLFormElement;
      const form = new FormData(element);
      const create = element.querySelector<HTMLButtonElement>('button:not([type="button"])')!;
      create.disabled = true;
      try {
        const name = String(form.get("name")).trim();
        const error = agentNameError(name);
        if (error) throw new Error(error);
        if (agents.some((a) => a.name === name)) throw new Error("Name already exists");
        const selected = form.get("model");
        const model = selected === null || selected === "" ? undefined : models[Number(selected)];
        if (!model) throw new Error("Choose a model");
        const result = await mutate("/new", {
          name, cwd,
          model: { provider: model.provider, modelId: model.modelId },
          thinking: form.get("thinking"),
        });
        agents = await api<Agent[]>("");
        await open(String(result.id));
      } catch (error) {
        fail(error);
      } finally {
        create.disabled = false;
      }
    };
    document.querySelector<HTMLInputElement>('[name="name"]')!.focus();
  };
  const chooseFolder = async (path?: string, returnCwd?: string) => {
    base(
      `<header>${button("←", "back", 'aria-label="Back"')}<h1>New agent</h1></header>
<main class="new"><form id="folder-form">
<label>Recent folders<select id="recent">
<option value="">Choose recent folder…</option>${recent}</select></label>
<section id="folders"></section>
${returnCwd ? '<button type="button" id="cancel-folder">Cancel</button>' : ""}<button>Use this folder</button>
</form></main>`,
    );
    if (returnCwd) {
      document.querySelector<HTMLButtonElement>("#cancel-folder")!.onclick = () => {
        void review(returnCwd);
      };
    }
    document.querySelector<HTMLSelectElement>("#recent")!.onchange = (event) => {
      const value = (event.target as HTMLSelectElement).value;
      if (value) void browse(value).catch(fail);
    };
    document.querySelector<HTMLFormElement>("#folder-form")!.onsubmit = async (event) => {
      event.preventDefault();
      const form = event.currentTarget as HTMLFormElement;
      const submit = form.querySelector<HTMLButtonElement>('button:not([type="button"])')!;
      submit.disabled = true;
      try {
        // Resolve typed paths through the folder picker before suggesting a name.
        await browse(document.querySelector<HTMLInputElement>("#folder")!.value);
        if (version !== generation || document.querySelector("#folder-form") !== form) return;
        if (document.querySelector("#folders .error")) return;
        await review(folder);
      } catch (error) {
        fail(error);
      } finally {
        submit.disabled = false;
      }
    };
    await browse(path);
  };
  const cwd = agents.find((a) => a.cwd)?.cwd;
  if (cwd) await review(cwd);
  else await chooseFolder();
}
async function rewind(entryId: string) {
  const result = await mutate("/tree", { target: stack.at(-1), entryId }) as { editorText?: string };
  await refresh();
  const input = document.querySelector<HTMLTextAreaElement>("#message");
  if (input && result.editorText !== undefined && !input.value.trim()) input.value = result.editorText;
}
async function treePicker() {
  type Node = { entry: { id: string; message: { role: string; content: string | { type: string; text?: string }[] } }; children: Node[] };
  const tree = await api<{ nodes: Node[]; leafId: string | null }>("/tree", { target: stack.at(-1) });
  const options = (nodes: Node[], depth = 0): string => nodes.map(node => {
    const m = node.entry.message;
    const text = typeof m.content === "string" ? m.content : m.content.filter(p => p.type === "text").map(p => p.text).join(" ");
    return `<option value="${e(node.entry.id)}" ${node.entry.id === tree.leafId ? "selected" : ""}>${e("—".repeat(depth) + " " + m.role + ": " + text.slice(0, 120))}</option>` + options(node.children, depth + 1);
  }).join("");
  if (!tree.nodes.length) throw new Error("No entries in session");
  showDialog("Session tree", `<select name="entryId" size="12">${options(tree.nodes)}</select>`, async form => {
    const id = String(form.get("entryId"));
    if (id !== tree.leafId) await rewind(id);
  });
}
// Rail navigation first returns to the shared parent history entry, then pushes a new pane.
let railTarget: string | undefined;
function collapseTo(depth: number) {
  if (depth < stack.length) history.go(-(stack.length - depth));
}
function openFromRail(id: string) {
  if (id === stack.at(-1)) return;
  const parent = agents.find(a => a.children.some(c => c.id === id));
  const depth = parent && stack[0] === parent.id ? 1 : 0;
  if (stack.length > depth) { railTarget = id; collapseTo(depth); }
  else void open(id).catch(fail);
}
root.addEventListener("click", async (event) => {
  const el = (event.target as HTMLElement).closest<HTMLElement>("button, [data-depth]");
  if (!el) return;
  try {
    if (el.dataset.depth !== undefined) { event.preventDefault(); collapseTo(Number(el.dataset.depth)); return; }
    if (el.dataset.rewind) { await rewind(el.dataset.rewind); return; }
    if (el.dataset.ask) { await answer(el.dataset.ask, el.dataset.title!, el.dataset.option); return; }
    if (el.dataset.open) {
      if (el.closest(".rail")) openFromRail(el.dataset.open);
      else await open(el.dataset.open);
      return;
    }
    if (el.dataset.dir) {
      await browse(el.dataset.dir);
      return;
    }
    const a = current();
    switch (el.dataset.action) {
      case "new":
        await newAgent();
        break;
      case "back":
        history.back();
        break;
      case "archived":
        showArchived = !showArchived;
        list();
        break;
      case "idle":
        showIdle = true;
        status();
        break;
      case "bottom": {
        const view = document.querySelector("#messages")!;
        view.scrollTop = view.scrollHeight;
        el.hidden = true;
        break;
      }
      case "dequeue": {
        const target = stack.at(-1)!;
        const version = generation;
        (el as HTMLButtonElement).disabled = true;
        try {
          const { texts } = await api<{ texts: string[] }>("/dequeue", { target });
          if (version !== generation || screen !== "chat") break;
          const input = document.querySelector<HTMLTextAreaElement>("#message")!;
          input.value = [...texts, input.value].filter(Boolean).join("\n\n");
          input.focus();
          await refresh();
        } finally { (el as HTMLButtonElement).disabled = false; }
        break;
      }
      case "model":
        if (a) await pickModel(a);
        break;
      case "stop":
        await mutate("/stop", { target: a?.id });
        break;
      case "folder-go":
        await browse((document.querySelector("#folder") as HTMLInputElement).value);
        break;
      case "older":
        await older();
        break;
      case "menu": {
        if (!a) break;
        const dialog = showDialog(
          a.name,
          `<button type="button" data-menu="rename">Rename</button>
<button type="button" data-menu="model">Model & thinking</button>
${a.archived ? `<button type="button" data-menu="unarchive">Unarchive</button>
<button type="button" data-menu="remove">Delete</button>` : '<button type="button" data-menu="archive">Archive</button>'}`,
        );
        dialog.querySelectorAll<HTMLElement>("[data-menu]").forEach(
          (item) =>
            (item.onclick = async () => {
              dialog.remove();
              try {
                if (item.dataset.menu === "rename")
                  showDialog(
                    "Rename agent",
                    `<label>Name<input name="name" value="${e(a.name)}" required></label>`,
                    async (form) => {
                      const name = String(form.get("name")).trim();
                      const error = agentNameError(name);
                      if (error) throw new Error(error);
                      await mutate("/rename", { target: a.id, name });
                    },
                  );
                if (item.dataset.menu === "model") await pickModel(a);
                if (item.dataset.menu === "unarchive") await mutate("/unarchive", { target: a.id });
                // Archive is undoable, so it needs no confirmation; delete is only offered for archived agents.
                if (item.dataset.menu === "archive" || item.dataset.menu === "remove" && confirm(`Delete ${a.name}${a.children.length ? ` and ${a.children.length} sub-agent${a.children.length === 1 ? "" : "s"}` : ""}? This can't be undone.`)) {
                  await mutate(`/${item.dataset.menu}`, { target: a.id });
                  stack = [];
                  history.replaceState({ screen: "list", stack: [] }, "", "/");
                  watchLife.abort();
                  agents = await api<Agent[]>("");
                  list();
                }
              } catch (error) {
                fail(error);
              }
            }),
        );
        break;
      }
    }
  } catch (error) {
    fail(error);
  }
});
root.addEventListener("change", (event) => {
  if ((event.target as HTMLElement).id === "notify") {
    const enabled = (event.target as HTMLInputElement).checked;
    void toggleNotifications(enabled).catch(() => {}).finally(() => { if (screen === "list") list(); });
    list();
  }
});
function showAttachments() {
  const container = document.querySelector("#attachments");
  if (!container) return;
  container.innerHTML = attachments.map((image, index) => `<button type="button" data-remove-image="${index}" aria-label="Remove image ${index + 1}"><img class="attachment" alt="Pending image" src="data:${image.mimeType};base64,${image.data}"> ×</button>`).join("");
}
async function attachImages(files: File[]) {
  const current = generation;
  try {
    for (const file of files) {
      if (!/^image\/(png|jpeg|gif|webp)$/.test(file.type)) continue;
      if (attachments.length >= 4) throw new Error("Attach at most four images");
      if (file.size > 4 * 1024 * 1024) throw new Error("Image exceeds 4 MiB");
      const data = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(",")[1]!);
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(file);
      });
      if (generation !== current || screen !== "chat") return;
      attachments.push({ type: "image", mimeType: file.type, data });
    }
  } catch (error) { fail(error); }
  showAttachments();
}
root.addEventListener("change", event => {
  const input = event.target as HTMLInputElement;
  if (input.id === "attach") { void attachImages(Array.from(input.files ?? [])); input.value = ""; }
});
root.addEventListener("click", event => {
  const button = (event.target as HTMLElement).closest<HTMLElement>("[data-remove-image]");
  if (button) { attachments.splice(Number(button.dataset.removeImage), 1); showAttachments(); }
});
root.addEventListener("paste", event => {
  if (!(event.target as HTMLElement).closest("#composer")) return;
  const files = Array.from(event.clipboardData?.files ?? []);
  if (files.some(file => file.type.startsWith("image/"))) { event.preventDefault(); void attachImages(files); }
});
root.addEventListener("dragover", event => {
  if ((event.target as HTMLElement).closest("#composer")) event.preventDefault();
});
root.addEventListener("drop", event => {
  if (!(event.target as HTMLElement).closest("#composer")) return;
  event.preventDefault(); void attachImages(Array.from(event.dataTransfer?.files ?? []));
});
root.addEventListener("submit", async (event) => {
  if ((event.target as HTMLElement).id !== "composer") return;
  event.preventDefault();
  const input = document.querySelector<HTMLTextAreaElement>("#message")!;
  const message = input.value.trim();
  if (!message && !attachments.length) return;
  const submit = document.querySelector<HTMLButtonElement>('#composer button[type="submit"]')!;
  submit.disabled = true;
  const target = stack.at(-1)!;
  // A forked agent opens with the chosen message waiting in its composer, as in Pi.
  const fork = async (before?: string, draft = "") => {
    const { id } = await mutate("/fork", { target, before }) as { id: string };
    stack = [];
    await open(id);
    document.querySelector<HTMLTextAreaElement>("#message")!.value = draft;
    saveDraft(id, draft);
  };
  const busy = async (label: string, work: () => Promise<void>) => {
    pending = label; status();
    try { await work(); } finally { pending = ""; status(); }
  };
  try {
    if (/^\/(model|thinking)(?:\s|$)/.test(message)) {
      const agent = current();
      if (!agent) throw new Error("No open agent");
      const isThinking = message.startsWith("/thinking");
      const arg = message.slice(isThinking ? 9 : 6).trim();
      input.value = "";
      if (!arg) { await pickModel(agent); return; }
      const models = await api<Model[]>("/models");
      const model = models.find(m => isThinking ? m.provider === agent.provider && m.modelId === agent.modelId : `${m.provider}/${m.modelId}` === arg || m.modelId === arg);
      if (!model) { await pickModel(agent); return; }
      const level = isThinking ? thinkingSelection(model, agent.thinking, arg) : modelThinking(model, agent.thinking);
      if (!level) { fail("Current model does not support thinking"); return; }
      await mutate("/model", { target, provider: model.provider, modelId: model.modelId, thinking: level });
      notice(isThinking ? `Thinking level: ${level}` : modelNotice(model, level));
      await refresh(); return;
    }
    if (/^\/compact(?:\s|$)/.test(message)) {
      input.value = "";
      await busy("Compacting context…", async () => {
        const result = await api<{ outcome: string; error?: string }>("/compact", { target, instructions: message.slice("/compact".length).trim() });
        if (result.outcome === "failed") throw new Error(`Compaction failed: ${result.error}`);
        if (result.outcome === "nothing") fail("Nothing to compact yet");
      });
      await refresh();
      return;
    }
    if (message === "/tree") { input.value = ""; await treePicker(); return; }
    if (message === "/clone") { input.value = ""; await busy("Cloning…", () => fork()); return; }
    if (message === "/new") { input.value = ""; await busy("Starting a new agent…", () => fork(NEW)); return; }
    if (message === "/fork") {
      input.value = "";
      const inputs = await api<{ id: string; text: string }[]>("/inputs", { target });
      if (!inputs.length) throw new Error("No messages to fork from");
      showDialog("Fork from message", `<label>Copy the conversation up to this message into a new agent
<select name="before">${inputs.map((m, i) => `<option value="${e(m.id)}" ${i === inputs.length - 1 ? "selected" : ""}>${e(m.text.replace(/\s+/g, " ").slice(0, 120))}</option>`).join("")}</select></label>`,
        async (form) => { const before = String(form.get("before")); await fork(before, inputs.find((m) => m.id === before)?.text); });
      return;
    }
    const images = attachments.slice();
    const queued = document.querySelector("#queued")!;
    queued.textContent = `Sending: ${message}${images.length ? " [image]" : ""}`;
    await mutate("/send", {
      target,
      message,
      images,
      mode: (document.querySelector("#steer") as HTMLInputElement).checked ? "steer" : "followUp",
    });
    input.value = "";
    saveDraft(target, "");
    attachments = [];
    showAttachments();
    const view = document.querySelector("#messages")!;
    view.scrollTop = view.scrollHeight;
    await refresh();
    view.scrollTop = view.scrollHeight;
    (document.querySelector("#new-messages") as HTMLElement).hidden = true;
  } catch (error) {
    fail(error);
  } finally {
    submit.disabled = false;
  }
});
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    rosterLife.abort();
    watchLife.abort();
  } else {
    startRoster();
    startWatch();
  }
});
const initialAgent = new URLSearchParams(location.hash.slice(1)).get("agent");
history.replaceState({ screen: "list", stack: [] }, "", "/");
function openFromLink() {
  const id = new URLSearchParams(location.hash.slice(1)).get("agent");
  if (id && token() && (screen !== "chat" || stack.at(-1) !== id)) void open(id);
}
window.addEventListener("hashchange", openFromLink);
navigator.serviceWorker?.addEventListener("message", (event) => {
  if (event.data?.type === "open-agent" && typeof event.data.agent === "string" && token()) void open(event.data.agent);
});
window.addEventListener("popstate", (event) => {
  generation++;
  watchLife.abort();
  const previousDepth = stack.length;
  stack = event.state?.stack ?? [];
  direction = stack.length < previousDepth ? "backward" : "forward";
  if (railTarget) {
    const id = railTarget; railTarget = undefined;
    void open(id).catch(fail);
    return;
  }
  if (stack.length) void open(stack.at(-1)!, false);
  else list();
});
setInterval(() => {
  if (screen === "list") {
    root.querySelectorAll<HTMLElement>("[data-time]").forEach((el) => {
      const a = all().find((a) => a.id === el.dataset.time);
      if (a) el.textContent = info(a);
    });
  } else status(true);
}, 1000);
if (token()) {
  list();
  startRoster();
  void notificationState().catch(error => { notifications.note = error instanceof Error ? error.message : String(error); }).finally(() => { if (screen === "list") list(); });
  if (initialAgent) void open(initialAgent);
} else unpair();

document.addEventListener("keydown", event => {
  if (screen !== "chat" || document.querySelector("dialog[open]") || event.isComposing) return;
  const input = document.querySelector<HTMLTextAreaElement>("#message");
  if (input?.value || attachments.length) return;
  const target = event.target as HTMLElement;
  if (target.matches("input, select, textarea, [contenteditable]") && target !== input) return;
  if (event.altKey && !event.ctrlKey && !event.metaKey && ["Digit1", "Digit2"].includes(event.code)) {
    const depth = event.code === "Digit1" ? 0 : 1;
    if (depth < stack.length) { event.preventDefault(); collapseTo(depth); }
  } else if (event.key === "ArrowLeft" && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && target === input) {
    event.preventDefault(); history.back();
  }
});
let edgeSwipe: { x: number; y: number } | undefined;
root.addEventListener("touchstart", event => {
  const touch = event.touches[0];
  edgeSwipe = matchMedia("(display-mode: standalone)").matches && !document.querySelector("dialog[open]") && stack.length && event.touches.length === 1 && touch && touch.clientX < 28
    ? { x: touch.clientX, y: touch.clientY } : undefined;
}, { passive: true });
root.addEventListener("touchcancel", () => { edgeSwipe = undefined; });
root.addEventListener("touchend", event => {
  const touch = event.changedTouches[0];
  if (edgeSwipe && touch && touch.clientX - edgeSwipe.x > 70 && Math.abs(touch.clientY - edgeSwipe.y) < 60) history.back();
  edgeSwipe = undefined;
}, { passive: true });
