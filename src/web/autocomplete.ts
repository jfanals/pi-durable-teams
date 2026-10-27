import { api } from "./api.ts";

interface Completion {
  value: string; label: string; description?: string;
  edit: { lines: string[]; cursorLine: number; cursorCol: number };
}
interface Suggestions { prefix: string; items: Completion[] }

/** The host supplies Pi's suggestions AND edits; the browser only renders and selects them. */
export function attachAutocomplete(input: HTMLTextAreaElement, target: string) {
  const menu = document.createElement("div");
  menu.className = "autocomplete";
  menu.id = "prompt-completions";
  menu.role = "listbox";
  menu.hidden = true;
  input.before(menu);
  input.setAttribute("aria-controls", menu.id);
  let suggestions: Suggestions | null = null;
  let selected = 0, version = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const close = () => { version++; clearTimeout(timer); suggestions = null; menu.hidden = true; input.removeAttribute("aria-activedescendant"); };
  const render = () => {
    menu.replaceChildren();
    suggestions?.items.forEach((item, i) => {
      const option = document.createElement("button");
      option.type = "button"; option.role = "option"; option.id = `completion-${i}`;
      option.setAttribute("aria-selected", String(i === selected));
      option.textContent = item.label + (item.description ? ` — ${item.description}` : "");
      option.addEventListener("mousedown", event => event.preventDefault());
      option.addEventListener("click", () => apply(i));
      menu.append(option);
    });
    menu.hidden = !suggestions?.items.length;
    input.setAttribute("aria-activedescendant", `completion-${selected}`);
    menu.children[selected]?.scrollIntoView({ block: "nearest" });
  };
  const apply = (index: number) => {
    const edit = suggestions?.items[index]?.edit;
    if (!edit) return;
    input.value = edit.lines.join("\n");
    const cursor = edit.lines.slice(0, edit.cursorLine).reduce((n, line) => n + line.length + 1, 0) + edit.cursorCol;
    input.setSelectionRange(cursor, cursor); close(); input.focus();
  };
  const request = async (tab = false) => {
    clearTimeout(timer);
    const id = ++version, text = input.value, cursor = input.selectionStart;
    const before = text.slice(0, cursor).split("\n").at(-1)!.trimStart();
    const force = tab && !(before.startsWith("/") && !before.includes(" "));
    try {
      const result = await api<Suggestions | null>("/complete", { target, text, cursor, force });
      if (id !== version || !input.isConnected || input.value !== text || input.selectionStart !== cursor) return;
      suggestions = result; selected = 0;
      if (force && result?.items.length === 1) apply(0);
      else render();
    } catch { if (id === version) close(); }
  };
  input.addEventListener("input", () => { close(); timer = setTimeout(() => void request(), 80); });
  input.addEventListener("click", close);
  input.addEventListener("blur", close);
  input.addEventListener("keydown", event => {
    if (event.isComposing || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
    if (suggestions?.items.length) {
      if (event.key === "Escape") { event.preventDefault(); close(); return; }
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        selected = (selected + (event.key === "ArrowDown" ? 1 : -1) + suggestions.items.length) % suggestions.items.length;
        render(); return;
      }
      if (event.key === "Tab" || event.key === "Enter") {
        event.preventDefault();
        const submit = event.key === "Enter" && suggestions.prefix.startsWith("/");
        apply(selected);
        if (submit) input.form?.requestSubmit();
        return;
      }
    }
    if (event.key === "Tab") { event.preventDefault(); void request(true); }
    else close();
  });
}
