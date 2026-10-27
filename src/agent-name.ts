export function agentNameError(name: string): string | undefined {
  if (!/^[a-zA-Z0-9][\w.-]{0,63}$/.test(name) || ["main", "human", "constructor", "prototype", "__proto__"].includes(name)) return "Use a unique 1–64 character name: letters/digits, dash, underscore, dot; not main";
}


/** A visible, editable suggestion, not an agent identity until creation succeeds. */
export function suggestedAgentName(cwd: string, existingNames: readonly string[]): string {
  const folder = cwd.replace(/\/+$/, "").split("/").at(-1) ?? "";
  const base = folder.replace(/[^a-zA-Z0-9_.-]+/g, "-").replace(/^[^a-zA-Z0-9]+/, "").slice(0, 64) || "agent";
  const name = agentNameError(base) ? "agent" : base;
  if (!existingNames.includes(name)) return name;
  for (let suffix = 2; ; suffix++) {
    const ending = `-${suffix}`;
    const candidate = name.slice(0, 64 - ending.length) + ending;
    if (!existingNames.includes(candidate)) return candidate;
  }
}
