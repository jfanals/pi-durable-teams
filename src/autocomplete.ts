import { CombinedAutocompleteProvider, type AutocompleteProvider, type SlashCommand } from "@earendil-works/pi-tui";
import { piCompletionTool } from "./presentation.ts";

// Only commands handled by our clients/host. Durable workers do not expand Pi prompt templates or /skill commands.
export const promptCommands: SlashCommand[] = [
  { name: "compact", description: "Compact conversation context" },
  { name: "fork", description: "Fork from a previous message" },
  { name: "clone", description: "Clone this conversation" },
];

/** Pi's provider, including its path quoting, fuzzy @ search and completion edits. Resolve cwd lazily as status arrives. */
export function promptAutocomplete(cwd: () => string): AutocompleteProvider {
  const provider = () => new CombinedAutocompleteProvider(promptCommands, cwd());
  return {
    async getSuggestions(lines, line, col, options) {
      return new CombinedAutocompleteProvider(promptCommands, cwd(), await piCompletionTool()).getSuggestions(lines, line, col, options);
    },
    applyCompletion: (lines, line, col, item, prefix) => provider().applyCompletion(lines, line, col, item, prefix),
    shouldTriggerFileCompletion: (lines, line, col) => provider().shouldTriggerFileCompletion(lines, line, col),
  };
}
