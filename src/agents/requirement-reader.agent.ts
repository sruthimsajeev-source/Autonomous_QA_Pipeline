import { extname } from "node:path";
import { readText } from "../utils/fs.js";

export class RequirementReaderAgent {
  async read(requirementSourcePath: string): Promise<string> {
    const raw = await readText(requirementSourcePath);
    const ext = extname(requirementSourcePath).toLowerCase();

    if (ext === ".json") {
      try {
        const parsed = JSON.parse(raw);
        if (parsed.description) {
          return String(parsed.description);
        }
        if (parsed.summary || parsed.title) {
          return `${parsed.title ?? parsed.summary}\n\n${parsed.body ?? ""}`;
        }
      } catch {
        return raw;
      }
    }

    console.log(`  [Reader] Source: ${requirementSourcePath}`);
    console.log(`  [Reader] Content (${raw.length} chars):\n${raw.trim()}`);
    return raw;
  }
}
