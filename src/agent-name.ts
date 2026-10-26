export function agentNameError(name: string): string | undefined {
  if (!/^[a-zA-Z0-9][\w.-]{0,63}$/.test(name) || ["main", "human", "constructor", "prototype", "__proto__"].includes(name)) return "Use a unique 1–64 character name: letters/digits, dash, underscore, dot; not main";
}

