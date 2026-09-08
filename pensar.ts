import * as fs from "node:fs";
import * as path from "node:path";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  ToolCallEvent,
  ToolCallEventResult,
  ToolResultEvent,
  SessionBeforeCompactEvent,
  BeforeAgentStartEvent,
  BeforeAgentStartEventResult,
  AgentSettledEvent
} from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";

export interface ModelSelectEvent {
  type: "model_select";
  model: any;
  previousModel?: any;
  source: string;
}

export interface SessionBeforeCompactResult {
  cancel?: boolean;
  customInstructions?: string;
}

/** Schema for the structured scratchpad `think` tool */
export const ThinkParams = Type.Object({
  thought: Type.String({
    description: "Raciocínio reflexivo, análise crítica da situação, premissas e planejamento passo a passo."
  }),
  stage: Type.Optional(Type.Union([
    Type.Literal("investigation"),
    Type.Literal("planning"),
    Type.Literal("verification"),
    Type.Literal("reflection")
  ], {
    description: "Fase do raciocínio: investigation (investigação), planning (planejamento), verification (verificação), reflection (reflexão)."
  })),
  hypotheses: Type.Optional(Type.Array(Type.String(), {
    description: "Hipóteses formuladas sobre causas, comportamento ou arquitetura."
  })),
  premises: Type.Optional(Type.Array(Type.String(), {
    description: "Premissas e restrições assumidas para a solução."
  })),
  verificationPlan: Type.Optional(Type.String({
    description: "Critérios e plano de validação e testes antes de qualquer mutação ou conclusão."
  }))
}, {
  description: "Ferramenta de scratchpad cognitivo estruturado para planejamento e raciocínio profundo."
});

export interface ThoughtEntry {
  thought: string;
  stage?: "investigation" | "planning" | "verification" | "reflection";
  hypotheses?: string[];
  premises?: string[];
  verificationPlan?: string;
  timestamp: number;
}

export interface PensarState {
  active: boolean;
  boostActive: boolean;
  singleShot: boolean;
  isNative: boolean;
  investigatedInTurn: boolean;
  turnReadPaths: Set<string>;
  createdPaths: Set<string>;
  sessionReadPaths: Set<string>;
}

export interface MentalState {
  thoughts: ThoughtEntry[];
  hypotheses: Set<string>;
  premises: Set<string>;
  plans: string[];
  lastTask?: string;
}

/** Check if a model supports native reasoning / thinking */
export function hasNativeReasoning(model: any): boolean {
  if (!model) return false;
  if (model.reasoning === true) return true;
  if (model.thinking === true) return true;

  // Array of thinking levels (must contain at least one level other than "off")
  if (Array.isArray(model.thinking)) {
    return model.thinking.some((t: any) => String(t).toLowerCase() !== "off");
  }

  // Object with efforts array (must contain at least one effort other than "off")
  if (model.thinking && Array.isArray(model.thinking.efforts)) {
    return model.thinking.efforts.some((t: any) => String(t).toLowerCase() !== "off");
  }

  // Model-level thinkingLevelMap with active levels
  if (model.thinkingLevelMap && typeof model.thinkingLevelMap === "object") {
    const levels = Object.entries(model.thinkingLevelMap);
    const hasActiveLevel = levels.some(([k, v]) => k.toLowerCase() !== "off" && v !== null && v !== undefined);
    if (hasActiveLevel) return true;
  }

  const id = (model.id || "").toLowerCase();
  const name = (model.name || "").toLowerCase();

  // Pattern matching known reasoning model identifiers (OpenAI o1/o3/o4, DeepSeek R1/reasoner, QwQ, Claude 3.7 with thinking, etc.)
  const reasoningPattern = /\b(o1|o3|o4|r1|deepseek-r1|deepseek-reasoner|qwq)\b/;
  if (reasoningPattern.test(id) || id.includes("reasoner") || id.includes("reasoning") || id.includes("thinking") || id.includes("thought")) {
    return true;
  }
  if (reasoningPattern.test(name) || name.includes("reasoner") || name.includes("reasoning") || name.includes("thinking") || name.includes("thought")) {
    return true;
  }
  return false;
}

/** Get the maximum appropriate thinking level for native reasoning */
export function getTargetThinkingLevel(model: any): string {
  if (!hasNativeReasoning(model)) return "off";

  // Gather declared thinking levels from model definition (excluding "off")
  let availableLevels: string[] = [];
  if (Array.isArray(model?.thinking)) {
    availableLevels = model.thinking.map(String).filter((l: string) => l.toLowerCase() !== "off");
  } else if (Array.isArray(model?.thinking?.efforts)) {
    availableLevels = model.thinking.efforts.map(String).filter((l: string) => l.toLowerCase() !== "off");
  } else if (model?.thinkingLevelMap && typeof model.thinkingLevelMap === "object") {
    availableLevels = Object.entries(model.thinkingLevelMap)
      .filter(([k, v]) => k.toLowerCase() !== "off" && v !== null && v !== undefined)
      .map(([k]) => k);
  }

  if (availableLevels.length > 0) {
    if (availableLevels.includes("high")) return "high";
    if (availableLevels.includes("max")) return "max";
    if (availableLevels.includes("xhigh")) return "xhigh";
    if (availableLevels.includes("medium")) return "medium";
    if (availableLevels.includes("low")) return "low";
    if (availableLevels.includes("minimal")) return "minimal";
    return availableLevels[availableLevels.length - 1];
  }

  return "high";
}

/** Extract command text from tool call input */
export function extractCommand(input: unknown): string {
  if (!input) return "";
  if (typeof input === "string") return input;
  if (typeof input === "object") {
    let raw = input as Record<string, unknown>;
    if (raw.params && typeof raw.params === "object") {
      const nested = extractCommand(raw.params);
      if (nested) return nested;
    }
    if (raw.parameters && typeof raw.parameters === "object") {
      const nested = extractCommand(raw.parameters);
      if (nested) return nested;
    }
    if (raw.arguments && typeof raw.arguments === "object") {
      const nested = extractCommand(raw.arguments);
      if (nested) return nested;
    }
    if (raw.args && typeof raw.args === "object" && !Array.isArray(raw.args)) {
      const nested = extractCommand(raw.args);
      if (nested) return nested;
    }

    let base = "";
    if (typeof raw.command === "string") base = raw.command;
    else if (Array.isArray(raw.command)) base = raw.command.map(String).join(" ");
    else if (typeof raw.cmd === "string") base = raw.cmd;
    else if (Array.isArray(raw.cmd)) base = raw.cmd.map(String).join(" ");
    else if (typeof raw.script === "string") base = raw.script;
    else if (typeof raw.commandLine === "string") base = raw.commandLine;
    else if (typeof raw.CommandLine === "string") base = raw.CommandLine;
    else if (typeof raw.code === "string") base = raw.code;

    const args = Array.isArray(raw.args) ? raw.args :
                 Array.isArray(raw.argv) ? raw.argv :
                 Array.isArray(raw.arguments) ? raw.arguments : undefined;

    if (args && args.length > 0) {
      const argsStr = args.map(String).join(" ");
      return base ? `${base} ${argsStr}` : argsStr;
    }
    return base;
  }
  return "";
}

/** Extract target file path from tool arguments with support for multiple parameter conventions */
export function extractTargetPath(input: unknown): string {
  if (!input) return "";
  if (typeof input === "string") return input.trim();
  if (typeof input === "object") {
    const raw = input as Record<string, unknown>;
    if (raw.params && typeof raw.params === "object") {
      const nested = extractTargetPath(raw.params);
      if (nested) return nested;
    }
    if (raw.parameters && typeof raw.parameters === "object") {
      const nested = extractTargetPath(raw.parameters);
      if (nested) return nested;
    }
    if (raw.arguments && typeof raw.arguments === "object") {
      const nested = extractTargetPath(raw.arguments);
      if (nested) return nested;
    }
    if (raw.args && typeof raw.args === "object" && !Array.isArray(raw.args)) {
      const nested = extractTargetPath(raw.args);
      if (nested) return nested;
    }

    const candidates = [
      raw.path,
      raw.Path,
      raw.filePath,
      raw.FilePath,
      raw.filepath,
      raw.file_path,
      raw.file,
      raw.File,
      raw.targetFile,
      raw.target_file,
      raw.TargetFile,
      raw.targetPath,
      raw.target_path,
      raw.TargetPath,
      raw.filename,
      raw.fileName,
      raw.FileName,
      raw.file_name,
      raw.target,
      raw.Target,
      raw.destination,
      raw.Destination,
      raw.dest,
      raw.Dest,
      raw.sourceFile,
      raw.SourceFile,
      raw.source_file,
      raw.NotebookPath,
      raw.notebookPath,
      raw.notebook_path,
      raw.AbsolutePath,
      raw.absolutePath,
      raw.uri,
      raw.Uri
    ];
    for (const c of candidates) {
      if (typeof c === "string" && c.trim()) return c.trim();
    }
  }
  return "";
}

/** Helper to normalize path keys for cross-platform matching */
export function normalizePathKey(p: string): string {
  if (!p) return "";
  let clean = p.replace(/\\/g, "/").trim();
  // Strip leading relative indicators like ./ or repeated ./.
  clean = clean.replace(/^(\.\/)+/, "");
  // Strip trailing slashes
  clean = clean.replace(/\/+$/, "");
  return clean.toLowerCase();
}

/** Detect if a shell command intends to perform filesystem or environment mutations */
export function isMutatingCommand(command: string): boolean {
  if (!command) return false;
  const cmd = command.trim();
  if (!cmd) return false;

  // 1. Redirection operators targeting files or variables (> or >> or &> or 1> or 2>)
  // Must NOT match:
  // - Descriptor duplication/merging e.g. 2>&1, 1>&2, >&2, >&1
  // - Discard targets: /dev/null, nul, NUL, $null
  // Must match:
  // - File paths: > file.txt, >> log.txt, &> out.txt, >"file with space"
  // - Compact paths: >file.txt, >>log.txt
  // - Variables: > $OUT, > ${OUT}, > $env:VAR
  if (/(?:>>?|[12]>>?|&>>?)\s*(?!&[0-9])(?!(?:(?:\/dev\/null|nul|NUL|\$null)(?:[\s;|&]|$)))[\w\.\/\\\-\~"'${}:]/.test(cmd)) {
    return true;
  }
  if (/\b(?:Out-File|Set-Content|Add-Content|Clear-Content)\b/i.test(cmd)) return true;

  // 2. File and directory deletions or moves (including Windows rmdir, rd, move, shred)
  if (/\b(?:rm|del|erase|Remove-Item|Move-Item|mv|move|rmdir|rd|shred)\b/i.test(cmd)) return true;

  // 3. Renaming files or directories
  if (/\b(?:Rename-Item|ren|rename)\b/i.test(cmd)) return true;

  // 4. File creation, copy, touch, truncate, or linking
  if (/\b(?:touch|cp|copy|Copy-Item|truncate|ln\s+-s|ln\s+\S+\s+\S+|mklink|robocopy|xcopy|rsync)\b/i.test(cmd)) return true;

  // 5. Directory creation
  if (/\b(?:mkdir|New-Item|md)\b/i.test(cmd)) return true;

  // 6. Archive extraction and decompression that mutates files
  if (/\b(?:unzip|gunzip|Expand-Archive|7z\s+x)\b|\btar\s+[^|;&\n]*\b-?[a-z]*x/i.test(cmd)) return true;

  // 7. Permissions / ownership mutation
  if (/\b(?:chmod|chown|icacls|takeown)\b/i.test(cmd)) return true;

  // 8. Git mutations (add, commit, checkout file/branch, switch, reset, rebase, merge, clean, apply, restore, pull, push, cherry-pick, branch deletion/rename, tag creation/deletion, stash, clone, init, revert)
  if (/\bgit\s+(?:add|commit|checkout|switch|reset|rebase|merge|clean|apply|restore|pull|push|cherry-pick|branch\s+(?:-[dDmM]|--delete)|tag\s+(?:-[dD]|v?\d)|stash|clone|init|revert)\b/i.test(cmd)) return true;

  // 9. Stream editors, tee, and patch tools
  if (/\b(?:sed\s+-i|patch|tee)\b/i.test(cmd)) return true;

  // 10. Package manager installations, updates, and removals
  if (/\b(?:npm|bun|pnpm|yarn)\s+(?:i|install|add|remove|uninstall|update)\b/i.test(cmd)) return true;
  if (/\b(?:pip|pip3|cargo)\s+(?:install|remove|update|add|uninstall)\b/i.test(cmd)) return true;
  if (/\bpython(?:\d+)?\s+-m\s+pip\s+(?:install|uninstall)\b/i.test(cmd)) return true;

  // 11. Download-to-file (curl -o, -O, --output, wget)
  if (/\b(?:curl\s+.*(?:-[oO]|--output)|wget(?!\s+.*-[oO]-)\b)/i.test(cmd)) return true;

  // 12. Inline code file mutations (node -e, python -c)
  if (/\bnode(?:\.exe)?\s+(?:-e|--eval)\s+.*(?:fs|promises)\.(?:write|append|unlink|rm|mkdir|copy|rename|truncate)/i.test(cmd)) return true;
  if (/\bpython(?:\d+)?(?:\.exe)?\s+-c\s+.*(?:open\s*\([^)]*['"][wa+]|(?:os|shutil|pathlib)\.(?:remove|unlink|rmdir|rmtree|mkdir|rename|replace|copy|write)|\.write_text|\.write_bytes)/i.test(cmd)) return true;

  return false;
}

/** Check if a shell command represents legitimate repository inspection, viewing, search, or test diagnostics */
export function isInvestigationCommand(command: string): boolean {
  if (!command) return false;
  const cmd = command.trim();
  if (!cmd) return false;

  // File viewing & paging
  if (/\b(?:cat|head|tail|more|less|type|bat|Get-Content|gc)\b/i.test(cmd)) return true;

  // Search & discovery
  if (/\b(?:grep|rg|ag|fd|find|findstr|Select-String|locate|which|where)\b/i.test(cmd)) return true;

  // Directory inspection
  if (/\b(?:ls|dir|tree|eza|exa|Get-ChildItem|gci)\b/i.test(cmd)) return true;

  // Git inspection (status, diff, log, show, branch listing)
  if (/\bgit\s+(?:status|diff|log|show|branch(?!\s+-[dDmM])|tag(?!\s+-[dD]))\b/i.test(cmd)) return true;

  // File checks, stats, hashes
  if (/\b(?:file|stat|wc|diff|cmp|md5sum|sha256sum)\b/i.test(cmd)) return true;

  // Test runners, linters, and compilers/checkers
  if (/\b(?:npm\s+test|bun\s+test|cargo\s+test|cargo\s+check|pytest|go\s+test|vitest|jest|tsc|eslint|node\s+--check|python(?:\d+)?\s+-m\s+unittest)\b/i.test(cmd)) return true;

  // Shell test commands e.g. test -f ...
  if (/\b(?:test\s+-[a-zA-Z]|\[\s+-[a-zA-Z])/i.test(cmd)) return true;

  return false;
}

/** Check if tool execution represents reading or inspecting the repository */
export function isInvestigationTool(toolName: string): boolean {
  const name = toolName.toLowerCase();
  return name === "read" ||
         name === "read_file" ||
         name === "readfile" ||
         name === "get_file" ||
         name === "view_file" ||
         name === "view" ||
         name === "grep" ||
         name === "grep_search" ||
         name === "find" ||
         name === "find_by_name" ||
         name === "find_files" ||
         name === "file_search" ||
         name === "ls" ||
         name === "dir" ||
         name === "list_dir" ||
         name === "list_directory" ||
         name === "list_files" ||
         name === "listfiles" ||
         name === "glob" ||
         name === "search";
}

/** Check if tool execution represents modifying or editing files */
export function isFileMutationTool(toolName: string): boolean {
  const name = toolName.toLowerCase();
  return name === "edit" ||
         name === "edit_file" ||
         name === "editfile" ||
         name === "file_editor" ||
         name === "str_replace_editor" ||
         name === "write" ||
         name === "write_to_file" ||
         name === "writefile" ||
         name === "create_file" ||
         name === "createfile" ||
         name === "new_file" ||
         name === "newfile" ||
         name === "save_file" ||
         name === "savefile" ||
         name === "append_file" ||
         name === "append_to_file" ||
         name === "appendfile" ||
         name === "update_file" ||
         name === "modify_file" ||
         name === "patch" ||
         name === "multiedit" ||
         name === "replace_file_content" ||
         name === "apply_patch" ||
         name === "applypatch" ||
         name === "notebook_edit";
}

/** Check if tool execution represents file creation or overwrite where anti-deadlock applies */
export function isFileWriteTool(toolName: string): boolean {
  const name = toolName.toLowerCase();
  return name === "write" ||
         name === "write_to_file" ||
         name === "writefile" ||
         name === "create_file" ||
         name === "createfile" ||
         name === "new_file" ||
         name === "newfile" ||
         name === "save_file" ||
         name === "savefile";
}

/** Helper to extract subagent name from task tool input */
export function getTaskAgentName(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  let raw = input as Record<string, unknown>;
  if (raw.params && typeof raw.params === "object") raw = raw.params as Record<string, unknown>;
  else if (raw.parameters && typeof raw.parameters === "object") raw = raw.parameters as Record<string, unknown>;
  else if (raw.arguments && typeof raw.arguments === "object") raw = raw.arguments as Record<string, unknown>;
  else if (raw.args && typeof raw.args === "object" && !Array.isArray(raw.args)) raw = raw.args as Record<string, unknown>;

  const agent = raw.agent || raw.Agent || raw.subagent || raw.Subagent || raw.name || raw.Name ||
                raw.target || raw.Target || raw.agentName || raw.role || raw.Role ||
                raw.agent_type || raw.subagent_type || raw.subagentType || raw.subagent_name ||
                raw.agent_name || raw.agentId || raw.agent_id || raw.subagentId || raw.subagent_id || raw.type;
  if (typeof agent === "string") return agent.trim().toLowerCase();
  return "";
}

/** Check if a task tool call targets an exploratory/investigation subagent (scout, debug-investigator, librarian) */
export function isInvestigationTask(toolName: string, input: unknown): boolean {
  const name = toolName.toLowerCase();
  const isTaskTool = name === "task" ||
                     name === "agent_task" ||
                     name === "subagent" ||
                     name === "delegate" ||
                     name === "run_agent" ||
                     name === "spawn_agent" ||
                     name === "sub_agent";
  if (!isTaskTool) return false;

  const agent = getTaskAgentName(input);
  if (
    agent === "scout" ||
    agent === "debug-investigator" ||
    agent === "librarian" ||
    agent.includes("scout") ||
    agent.includes("investigat") ||
    agent.includes("librarian") ||
    agent.includes("explor") ||
    agent.includes("inspect")
  ) {
    return true;
  }

  // Check prompt/task text for explicit investigation directives
  if (input && typeof input === "object") {
    let raw = input as Record<string, unknown>;
    if (raw.params && typeof raw.params === "object") raw = raw.params as Record<string, unknown>;
    else if (raw.parameters && typeof raw.parameters === "object") raw = raw.parameters as Record<string, unknown>;
    else if (raw.arguments && typeof raw.arguments === "object") raw = raw.arguments as Record<string, unknown>;

    const text = typeof raw.prompt === "string" ? raw.prompt :
                 typeof raw.task === "string" ? raw.task :
                 typeof raw.description === "string" ? raw.description : "";
    if (text) {
      const lower = text.toLowerCase();
      if (
        lower.includes("scout") ||
        lower.includes("debug-investigator") ||
        lower.includes("librarian") ||
        lower.includes("investigate") ||
        lower.includes("investigar") ||
        lower.includes("explore") ||
        lower.includes("explorar") ||
        lower.includes("inspecionar") ||
        lower.includes("mapear") ||
        lower.includes("buscar")
      ) {
        return true;
      }
    }
  }

  return false;
}

/** Extract file paths from task tool input */
export function extractPathsFromTaskInput(input: unknown): string[] {
  if (!input || typeof input !== "object") return [];
  const raw = input as Record<string, unknown>;
  const paths: string[] = [];
  if (typeof raw.path === "string") paths.push(raw.path);
  if (typeof raw.file === "string") paths.push(raw.file);
  if (Array.isArray(raw.paths)) {
    for (const p of raw.paths) if (typeof p === "string") paths.push(p);
  }
  if (Array.isArray(raw.files)) {
    for (const f of raw.files) {
      if (typeof f === "string") paths.push(f);
      else if (f && typeof f === "object" && typeof (f as any).path === "string") paths.push((f as any).path);
    }
  }
  return paths;
}

/** Extract inspected file paths from tool_result event (subagents, tools) */
export function extractPathsFromToolResult(event: ToolResultEvent): string[] {
  if (event.isError) return [];

  const found = new Set<string>();

  const sanitizePath = (raw: string): string => {
    let clean = raw.trim();
    // Remove surrounding quotes, backticks, brackets, parentheses, angle brackets
    clean = clean.replace(/^[('"`\[<]+|[)'"`\]>]+$/g, "").trim();
    // Remove line number / column / anchor suffixes like :12-34 or :12:34 or :12 or #L12-L34 or #L12
    clean = clean.replace(/:\d+(?:[:\-]\d+)?$/, "").trim();
    clean = clean.replace(/#L?\d+(?:[-–]L?\d+)?$/i, "").trim();
    // Remove trailing punctuation (commas, periods, semicolons, colons) from text sentences
    clean = clean.replace(/[.,;:]+$/, "").trim();
    clean = clean.replace(/^['"`]|['"`]$/g, "").trim();
    return clean;
  };

  const ignoredWords = new Set(["e.g", "i.e", "ex", "vs", "etc", "viz", "ref", "http", "https"]);

  const isValidCandidate = (p: string): boolean => {
    if (!p || p.length < 2) return false;
    if (ignoredWords.has(p.toLowerCase())) return false;
    if (p.startsWith("http://") || p.startsWith("https://") || p.startsWith("data:") || p.startsWith("ftp://")) return false;
    if (/^\d+(?:\.\d+)+$/.test(p)) return false;
    if (p.includes("/") || p.includes("\\") || /\.[a-zA-Z0-9_-]{1,10}$/.test(p)) {
      return true;
    }
    return false;
  };

  const addCandidate = (candidate: unknown) => {
    if (typeof candidate === "string") {
      const clean = sanitizePath(candidate);
      if (isValidCandidate(clean)) {
        found.add(clean);
      }
    } else if (candidate && typeof candidate === "object") {
      extractFromObject(candidate, 2);
    }
  };

  const extractFromObject = (obj: unknown, maxDepth: number = 4) => {
    if (!obj || maxDepth < 0) return;
    if (typeof obj === "string") {
      addCandidate(obj);
      return;
    }
    if (Array.isArray(obj)) {
      for (const item of obj) extractFromObject(item, maxDepth - 1);
      return;
    }
    if (typeof obj === "object") {
      const raw = obj as Record<string, unknown>;
      // Check direct candidate properties
      for (const key of [
        "path", "file", "filepath", "filePath", "file_path", "filename", "fileName", "file_name",
        "target", "source", "name", "uri", "destination", "dest", "targetFile", "TargetFile"
      ]) {
        if (typeof raw[key] === "string") {
          addCandidate(raw[key]);
        }
      }
      // Check common list properties
      for (const key of [
        "files", "sources", "paths", "investigatedPaths", "readFiles",
        "inspectedFiles", "inspected_files", "matches", "entries", "artifacts"
      ]) {
        if (Array.isArray(raw[key])) {
          for (const item of raw[key]) extractFromObject(item, maxDepth - 1);
        }
      }
      // Check common nested containers (e.g. details.output.files, details.result.files)
      for (const key of ["output", "result", "data", "payload", "response"]) {
        if (raw[key] && typeof raw[key] === "object") {
          extractFromObject(raw[key], maxDepth - 1);
        }
      }
    }
  };

  // 1. Inspect input
  if (event.input && typeof event.input === "object") {
    extractFromObject(event.input, 3);
  }

  // 2. Inspect details
  if (event.details && typeof event.details === "object") {
    extractFromObject(event.details, 4);
  }

  // 3. Inspect top-level result or output if present
  if ((event as any).result && typeof (event as any).result === "object") {
    extractFromObject((event as any).result, 4);
  }
  if ((event as any).output && typeof (event as any).output === "object") {
    extractFromObject((event as any).output, 4);
  }

  // 4. Inspect text content
  if (Array.isArray(event.content)) {
    for (const item of event.content) {
      if (item && item.type === "text" && typeof item.text === "string") {
        const text = item.text;

        // Try JSON parsing
        try {
          const parsed = JSON.parse(text);
          extractFromObject(parsed, 4);
        } catch {}

        // Match backtick file references: `src/path/file.ts`
        const backtickMatches = text.matchAll(/`([^`\n\r]+)`/g);
        for (const match of backtickMatches) {
          if (match[1]) addCandidate(match[1]);
        }

        // Match XML / HTML tags: <file>src/app.ts</file> or <path>src/app.ts</path>
        const xmlMatches = text.matchAll(/<(?:file|path|source|arquivo)>([^<]+)<\/(?:file|path|source|arquivo)>/gi);
        for (const match of xmlMatches) {
          if (match[1]) addCandidate(match[1]);
        }
        const xmlAttrMatches = text.matchAll(/<(?:file|path|source)\s+[^>]*?(?:path|file|href)=["']([^"']+)["']/gi);
        for (const match of xmlAttrMatches) {
          if (match[1]) addCandidate(match[1]);
        }

        // Match field patterns: "path: src/app.ts" or "file: src/app.ts"
        const fieldMatches = text.matchAll(/(?:path|file|files|source|arquivo|target|filepath|filename):\s*["']?([^"'\s\n\r,]+)/gi);
        for (const match of fieldMatches) {
          if (match[1]) addCandidate(match[1]);
        }

        // Match Markdown bullet lists (including Windows drive letter prefix e.g. - C:\path\app.ts:15:3)
        const listMatches = text.matchAll(/(?:^|\n)\s*(?:[-*+]|\d+\.)\s+((?:[a-zA-Z]:[/\\])?[a-zA-Z0-9_\-\.\/\\\\]+\.[a-zA-Z0-9_\-]{1,10}(?::\d+(?:[:\-]\d+)?)?)/g);
        for (const match of listMatches) {
          if (match[1]) addCandidate(match[1]);
        }

        // Match file paths in prose text (e.g. "checked src/services/auth.ts and lib/db.ts")
        const proseMatches = text.matchAll(/(?:^|[\s"'`(<[])((?:[a-zA-Z]:[/\\]|[./\\]|[a-zA-Z0-9_\-\.]+[/\\])[a-zA-Z0-9_\-\./\\]*\.[a-zA-Z0-9_\-]{1,10}(?::\d+(?:[:\-]\d+)?)?)/g);
        for (const match of proseMatches) {
          if (match[1]) addCandidate(match[1]);
        }
      }
    }
  }

  return Array.from(found);
}

/** Distinguish existing files from legitimate new file creation (anti-deadlock R3) */
export function isExistingFile(targetPath: string, cwd?: string, ctx?: any): boolean {
  if (!targetPath) return false;

  const key = normalizePathKey(targetPath);

  const matchesKey = (collection: any, k: string): boolean => {
    if (!collection) return false;
    const has = (itemKey: string) => {
      if (collection instanceof Set) return collection.has(itemKey);
      if (Array.isArray(collection)) return collection.some(i => normalizePathKey(String(i)) === itemKey);
      return false;
    };
    if (has(k)) return true;
    if (/^[a-z]:\//.test(k) && has(k.slice(2))) return true;
    if (k.startsWith("/")) {
      const items = collection instanceof Set ? Array.from(collection) : Array.isArray(collection) ? collection : [];
      for (const item of items) {
        const itemKey = normalizePathKey(String(item));
        if (/^[a-z]:\//.test(itemKey) && itemKey.slice(2) === k) return true;
      }
    }
    return false;
  };

  // 1. Mock context support in test harnesses
  if (matchesKey(ctx?.existingFiles, key)) return true;
  if (matchesKey(ctx?.newFiles, key)) return false;

  // Check absolute/relative correspondence in mock collections if effectiveCwd exists
  const effectiveCwd = cwd || ctx?.cwd;
  if (effectiveCwd && typeof effectiveCwd === "string") {
    try {
      const absKey = normalizePathKey(path.isAbsolute(targetPath) ? targetPath : path.resolve(effectiveCwd, targetPath));
      const relKey = normalizePathKey(path.isAbsolute(targetPath) ? path.relative(effectiveCwd, targetPath) : targetPath);
      if (matchesKey(ctx?.existingFiles, absKey) || matchesKey(ctx?.existingFiles, relKey)) return true;
      if (matchesKey(ctx?.newFiles, absKey) || matchesKey(ctx?.newFiles, relKey)) return false;
    } catch {}
  }

  // 2. Real filesystem check (when running in a real project directory)
  if (effectiveCwd && typeof effectiveCwd === "string") {
    try {
      if (fs.existsSync(effectiveCwd)) {
        const fullPath = path.isAbsolute(targetPath) ? targetPath : path.resolve(effectiveCwd, targetPath);
        if (fs.existsSync(fullPath)) {
          try {
            return fs.statSync(fullPath).isFile();
          } catch {
            return true;
          }
        }
        // Directory exists on real filesystem, but target file does not: definitely a new file
        return false;
      }
    } catch {}
  }

  // If path is absolute and its parent directory exists on the real filesystem
  if (path.isAbsolute(targetPath)) {
    try {
      const parentDir = path.dirname(targetPath);
      if (fs.existsSync(parentDir)) {
        if (fs.existsSync(targetPath)) {
          try {
            return fs.statSync(targetPath).isFile();
          } catch {
            return true;
          }
        }
        return false;
      }
    } catch {}
  }

  // 3. Fallback when cwd is missing or does not exist on disk (mock test harnesses)
  const baseName = path.basename(targetPath).toLowerCase();
  if (
    baseName === "plano.md" ||
    baseName === "plan.md" ||
    baseName.startsWith("new_") ||
    baseName.startsWith("novo_") ||
    baseName.startsWith("nova_") ||
    baseName.includes(".new.") ||
    baseName.endsWith(".new")
  ) {
    return false;
  }

  return true;
}

/** Builds structured 4-stage orchestration prompt for /boost commands */
export function buildBoostPrompt(task: string): string {
  return [
    "[PROTOCOLO DE ORQUESTRAÇÃO ESTRUTURADA - BOOST]",
    "Execute a tarefa a seguir com excelência de engenharia de software, aplicando rigorosamente o protocolo em 4 etapas:",
    "",
    "1. ETAPA 1 - EXPLORAÇÃO E INVESTIGAÇÃO:",
    "- Inspecione o repositório, contexto e arquivos relevantes antes de planejar ou alterar código.",
    "- Para buscas amplas, mapeamento de arquitetura ou leituras de múltiplos arquivos, utilize o subagente nativo 'scout'.",
    "- Para diagnóstico de falhas complexas, utilize 'debug-investigator' ou 'librarian'.",
    "",
    "2. ETAPA 2 - PLANEJAMENTO E DECOMPOSIÇÃO:",
    "- Formule hipóteses, premissas e riscos com precisão cirúrgica.",
    "- Registre seu raciocínio estruturado (via ferramenta 'think' se em modelo scratchpad).",
    "- Estruture planos atômicos e seguros (como 'PLANO.md' se necessário) sem risco de deadlock.",
    "",
    "3. ETAPA 3 - EXECUÇÃO CIRÚRGICA:",
    "- Aplique alterações mínimas, focadas e sem refatorações não solicitadas.",
    "- Mantenha rigorosa compatibilidade de contratos e preserve a integridade da base de código.",
    "- Guardrails de mutabilidade protegem arquivos existentes contra alterações cegas.",
    "",
    "4. ETAPA 4 - VERIFICAÇÃO E AUDITORIA:",
    "- Valide com testes automatizados reais (nunca enfraqueça testes para fazê-los passar).",
    "- Execute verificação estática de tipos (tsc --noEmit) e linters.",
    "- Teste casos de borda e caminhos de erro explicitamente.",
    "- Sugira ou invoque o subagente nativo 'code-quality-reviewer' para auditoria independente de integridade.",
    "",
    "TAREFA:",
    task
  ].join("\n");
}

/**
 * Extensão cognitiva `/pensar` e `/boost` para Oh My Pi (OMP).
 *
 * Potencializa modelos com raciocínio adaptativo (Anti-Double-Thinking),
 * scratchpad estruturado para modelos menores, protocolo de orquestração estruturada /boost,
 * desbloqueio integrado com subagentes nativos (scout, debug-investigator, librarian),
 * criação anti-deadlock de novos arquivos e persistência resiliente à compactação.
 */
export default function pensarExtension(pi: ExtensionAPI): void {
  const pensarState: PensarState = {
    active: false,
    boostActive: false,
    singleShot: false,
    isNative: false,
    investigatedInTurn: false,
    turnReadPaths: new Set<string>(),
    createdPaths: new Set<string>(),
    sessionReadPaths: new Set<string>()
  };

  const mentalState: MentalState = {
    thoughts: [],
    hypotheses: new Set<string>(),
    premises: new Set<string>(),
    plans: []
  };

  const pendingInvestigations = new Map<string, { paths: string[]; isTask: boolean; isShell?: boolean }>();
  const pendingCreations = new Map<string, string>();

  /** Register the synthetic structured scratchpad tool */
  pi.registerTool({
    name: "think",
    label: "Think (Scratchpad Cognitivo)",
    description: "Ferramenta de scratchpad cognitivo estruturado. Registre premissas, hipóteses, planos e análises críticas antes de ações no código.",
    promptSnippet: "think: Ferramenta de reflexão, planejamento passo a passo e formulação de hipóteses.",
    promptGuidelines: [
      "Utilize a ferramenta `think` como seu scratchpad estruturado antes de modificar arquivos ou executar comandos mutatórios.",
      "Formule hipóteses claras, identifique potenciais armadilhas e estabeleça critérios de verificação antes de qualquer mutação.",
      "Inspecione arquivos com `read` ou `grep` antes de propor alterações definitivas."
    ],
    parameters: ThinkParams,
    prepareArguments: (args: unknown) => {
      if (typeof args === "string") return { thought: args };
      if (args && typeof args === "object") {
        const raw = args as Record<string, unknown>;
        const thought = typeof raw.thought === "string" ? raw.thought :
                        Array.isArray(raw.thought) ? raw.thought.map(String).join("\n") :
                        typeof raw.thinking === "string" ? raw.thinking :
                        typeof raw.thoughts === "string" ? raw.thoughts :
                        Array.isArray(raw.thoughts) ? raw.thoughts.map(String).join("\n") :
                        typeof raw.reasoning === "string" ? raw.reasoning :
                        typeof raw.analysis === "string" ? raw.analysis :
                        typeof raw.plan === "string" ? raw.plan :
                        typeof raw.content === "string" ? raw.content :
                        JSON.stringify(args);
        const rawStage = (typeof raw.stage === "string" ? raw.stage :
                          typeof raw.fase === "string" ? raw.fase :
                          typeof raw.phase === "string" ? raw.phase :
                          typeof raw.etapa === "string" ? raw.etapa :
                          typeof raw.step === "string" ? raw.step : undefined)?.toLowerCase().trim();
        let stage: "investigation" | "planning" | "verification" | "reflection" | undefined = undefined;
        if (rawStage === "investigation" || rawStage === "planning" || rawStage === "verification" || rawStage === "reflection") {
          stage = rawStage;
        } else if (
          rawStage === "investigacao" || rawStage === "investigação" ||
          rawStage === "investigate" || rawStage === "explore" ||
          rawStage === "exploracao" || rawStage === "exploração" ||
          rawStage === "explorar" || rawStage === "inspect" ||
          rawStage === "inspecionar" || rawStage === "inspecao" || rawStage === "inspeção"
        ) {
          stage = "investigation";
        } else if (
          rawStage === "planejamento" || rawStage === "planejar" ||
          rawStage === "plan" || rawStage === "decomposition" ||
          rawStage === "decomposicao" || rawStage === "decomposição"
        ) {
          stage = "planning";
        } else if (
          rawStage === "verificacao" || rawStage === "verificação" ||
          rawStage === "verify" || rawStage === "verificar" ||
          rawStage === "audit" || rawStage === "auditoria" ||
          rawStage === "test" || rawStage === "teste"
        ) {
          stage = "verification";
        } else if (
          rawStage === "reflexao" || rawStage === "reflexão" ||
          rawStage === "reflect" || rawStage === "review" ||
          rawStage === "revisao" || rawStage === "revisão"
        ) {
          stage = "reflection";
        }

        const rawHypotheses = raw.hypotheses ?? raw.hipoteses;
        const rawHypothesis = raw.hypothesis ?? raw.hipotese;
        const hypotheses = Array.isArray(rawHypotheses) ? rawHypotheses.map(String) :
                           typeof rawHypothesis === "string" ? [rawHypothesis] :
                           Array.isArray(rawHypothesis) ? rawHypothesis.map(String) : undefined;

        const rawPremises = raw.premises ?? raw.premissas;
        const rawPremise = raw.premise ?? raw.premissa;
        const premises = Array.isArray(rawPremises) ? rawPremises.map(String) :
                         typeof rawPremise === "string" ? [rawPremise] :
                         Array.isArray(rawPremise) ? rawPremise.map(String) : undefined;

        const verificationPlan = typeof raw.verificationPlan === "string" ? raw.verificationPlan :
                                 typeof raw.verification_plan === "string" ? raw.verification_plan :
                                 typeof raw.plano_de_verificacao === "string" ? raw.plano_de_verificacao :
                                 typeof raw.plano_verificacao === "string" ? raw.plano_verificacao :
                                 typeof raw.plano === "string" ? raw.plano :
                                 typeof raw.plan === "string" && typeof raw.thought === "string" ? raw.plan : undefined;
        return { thought, stage, hypotheses, premises, verificationPlan };
      }
      return { thought: String(args ?? "") };
    },
    execute: async (_toolCallId, params) => {
      const entry: ThoughtEntry = {
        thought: params.thought,
        stage: params.stage,
        hypotheses: params.hypotheses,
        premises: params.premises,
        verificationPlan: params.verificationPlan,
        timestamp: Date.now()
      };
      mentalState.thoughts.push(entry);
      if (params.hypotheses) {
        for (const h of params.hypotheses) mentalState.hypotheses.add(h);
      }
      if (params.premises) {
        for (const p of params.premises) mentalState.premises.add(p);
      }
      if (params.verificationPlan) {
        mentalState.plans.push(params.verificationPlan);
      }

      const stageLabel = params.stage ? `[${params.stage.toUpperCase()}] ` : "";
      return {
        content: [{
          type: "text",
          text: `${stageLabel}Raciocínio registrado no scratchpad cognitivo. Prossiga com a investigação ou execução planejada.`
        }],
        details: {
          stage: params.stage ?? "investigation",
          thoughtLength: params.thought.length,
          hypothesesCount: params.hypotheses?.length ?? 0,
          premisesCount: params.premises?.length ?? 0
        }
      };
    }
  });

  /** Calibrate reasoning mode: Native reasoning vs Scratchpad tool */
  function recalibrate(model: any, ctx: ExtensionContext): void {
    const isNative = hasNativeReasoning(model);
    pensarState.isNative = isNative;

    if (isNative) {
      // Model with native reasoning: activate thinkingLevel high/max, remove synthetic think tool
      const targetLevel = getTargetThinkingLevel(model);
      try {
        pi.setThinkingLevel(targetLevel as any);
      } catch {}

      const activeTools = pi.getActiveTools?.() || [];
      if (activeTools.includes("think")) {
        pi.setActiveTools(activeTools.filter(t => t !== "think"));
      }
      ctx.ui?.setStatus?.("pensar", pensarState.active ? "🧠 Pensar [Ativo]" : undefined);
      ctx.ui?.setStatus?.("boost", pensarState.boostActive ? "🚀 Boost [Ativo]" : undefined);
    } else {
      // Model without native reasoning: keep thinkingLevel off, activate synthetic think tool
      try {
        pi.setThinkingLevel("off");
      } catch {}

      const activeTools = pi.getActiveTools?.() || [];
      if (!activeTools.includes("think")) {
        pi.setActiveTools([...activeTools, "think"]);
      }
      ctx.ui?.setStatus?.("pensar", pensarState.active ? "🧠 Pensar [Ativo]" : undefined);
      ctx.ui?.setStatus?.("boost", pensarState.boostActive ? "🚀 Boost [Ativo]" : undefined);
    }
  }

  /** Activate thinking mode */
  function activate(ctx: ExtensionContext, singleShot: boolean): void {
    pensarState.active = true;
    pensarState.singleShot = singleShot;
    recalibrate(ctx.model, ctx);
    ctx.ui?.notify?.(`Modo Pensar ativado${singleShot ? " [Modo Pontual]" : ""}.`, "info");
  }

  /** Deactivate thinking mode */
  function deactivate(ctx: ExtensionContext, reason?: string): void {
    pensarState.active = false;
    pensarState.singleShot = false;
    ctx.ui?.setStatus?.("pensar", undefined);

    if (pensarState.boostActive) {
      recalibrate(ctx.model, ctx);
    } else {
      pensarState.createdPaths.clear();
      pensarState.sessionReadPaths.clear();
      pendingCreations.clear();
      const activeTools = pi.getActiveTools?.() || [];
      if (activeTools.includes("think")) {
        pi.setActiveTools(activeTools.filter(t => t !== "think"));
      }
      try {
        pi.setThinkingLevel("off");
      } catch {}
    }

    ctx.ui?.notify?.(reason ? `Modo Pensar desativado: ${reason}` : "Modo Pensar desativado.", "info");
  }

  /** Handler for /pensar command: continuous cognitive mode */
  const pensarCommandHandler = async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
    const trimmed = args.trim();

    if (trimmed.toLowerCase() === "on") {
      if (!pensarState.active) {
        activate(ctx, false);
      } else {
        if (pensarState.singleShot) {
          pensarState.singleShot = false;
          ctx.ui?.notify?.("Modo Pensar fixado como ativo permanente.", "info");
        } else {
          ctx.ui?.notify?.("Modo Pensar já está ativo.", "info");
        }
      }
      return;
    }

    if (trimmed.toLowerCase() === "off") {
      if (pensarState.active) {
        deactivate(ctx);
      } else {
        ctx.ui?.notify?.("Modo Pensar já está desativado.", "info");
      }
      return;
    }

    // Toggle when invoked without arguments
    if (!trimmed) {
      if (pensarState.active) {
        deactivate(ctx);
      } else {
        activate(ctx, false);
      }
      return;
    }

    // Single-shot mode with specific task
    activate(ctx, true);
    mentalState.lastTask = trimmed;
    ctx.ui?.notify?.(
      `Executando tarefa com raciocínio profundo: "${trimmed.length > 50 ? trimmed.slice(0, 47) + "..." : trimmed}"`,
      "info"
    );
    try {
      const options = (typeof ctx.isIdle === "function" && !ctx.isIdle())
        ? { deliverAs: "followUp" as const }
        : undefined;
      await pi.sendUserMessage(trimmed, options);
    } catch (err) {
      deactivate(ctx, "Falha ao executar tarefa pontual.");
      ctx.ui?.notify?.(
        `Erro ao executar tarefa pontual: ${err instanceof Error ? err.message : String(err)}`,
        "error"
      );
    }
  };

  /** Handler for /boost command: structured 4-stage orchestration protocol */
  const boostCommandHandler = async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
    const trimmed = args.trim();

    if (trimmed.toLowerCase() === "on") {
      if (!pensarState.boostActive) {
        pensarState.boostActive = true;
        pensarState.singleShot = false;
        recalibrate(ctx.model, ctx);
        ctx.ui?.notify?.("Modo Boost ativado: protocolo de excelência em 4 etapas habilitado.", "info");
      } else {
        ctx.ui?.notify?.("Modo Boost já está ativo.", "info");
      }
      return;
    }

    if (trimmed.toLowerCase() === "off") {
      if (pensarState.boostActive) {
        pensarState.boostActive = false;
        ctx.ui?.setStatus?.("boost", undefined);
        if (pensarState.active) recalibrate(ctx.model, ctx);
        ctx.ui?.notify?.("Modo Boost desativado.", "info");
      } else {
        ctx.ui?.notify?.("Modo Boost já está desativado.", "info");
      }
      return;
    }

    // Toggle when invoked without arguments
    if (!trimmed) {
      if (pensarState.boostActive) {
        pensarState.boostActive = false;
        ctx.ui?.setStatus?.("boost", undefined);
        if (pensarState.active) recalibrate(ctx.model, ctx);
        ctx.ui?.notify?.("Modo Boost desativado.", "info");
      } else {
        pensarState.boostActive = true;
        pensarState.singleShot = false;
        recalibrate(ctx.model, ctx);
        ctx.ui?.notify?.("Modo Boost ativado: protocolo de excelência em 4 etapas habilitado.", "info");
      }
      return;
    }

    // Directed 4-stage orchestration for specific task
    pensarState.boostActive = true;
    pensarState.singleShot = true;
    recalibrate(ctx.model, ctx);
    mentalState.lastTask = trimmed;
    ctx.ui?.notify?.(
      `Executando tarefa com protocolo /boost: "${trimmed.length > 45 ? trimmed.slice(0, 42) + "..." : trimmed}"`,
      "info"
    );
    try {
      const options = (typeof ctx.isIdle === "function" && !ctx.isIdle())
        ? { deliverAs: "followUp" as const }
        : undefined;
      const boostPrompt = buildBoostPrompt(trimmed);
      await pi.sendUserMessage(boostPrompt, options);
    } catch (err) {
      deactivate(ctx, "Falha ao executar tarefa /boost.");
      ctx.ui?.notify?.(
        `Erro ao executar tarefa /boost: ${err instanceof Error ? err.message : String(err)}`,
        "error"
      );
    }
  };

  // Register commands
  pi.registerCommand("pensar", {
    description: "Ativa/desativa raciocínio profundo contínuo ou executa tarefa pontual (/pensar [tarefa])",
    handler: pensarCommandHandler
  });

  pi.registerCommand("boost", {
    description: "Executa protocolo de orquestração estruturada em 4 etapas com subagentes (/boost <tarefa>)",
    handler: boostCommandHandler
  });

  // Dynamic model switch recalibrates mode (Native vs Scratchpad) while preserving cognitive state
  pi.on("model_select", (event: ModelSelectEvent, ctx: ExtensionContext) => {
    if (pensarState.active || pensarState.boostActive) {
      recalibrate(event?.model, ctx);
      const modeDesc = pensarState.isNative ? "Raciocínio Nativo" : "Scratchpad Cognitivo";
      const modelName = event?.model?.name || event?.model?.id || "desconhecido";
      ctx.ui?.notify?.(
        `Modelo alterado para ${modelName}. Raciocínio recalibrado para: ${modeDesc}.`,
        "info"
      );
    }
  });

  // Single-shot automatic deactivation on settled
  pi.on("agent_settled", (_event: AgentSettledEvent, ctx: ExtensionContext) => {
    pensarState.investigatedInTurn = false;
    pensarState.turnReadPaths.clear();
    pendingInvestigations.clear();
    pendingCreations.clear();

    if (pensarState.singleShot) {
      pensarState.singleShot = false;
      if (pensarState.boostActive) {
        pensarState.boostActive = false;
        ctx.ui?.setStatus?.("boost", undefined);
      } else if (pensarState.active) {
        deactivate(ctx, "Tarefa pontual concluída.");
      }
    }
  });

  // Turn initialization: reset investigation tracker on conversational turn start
  pi.on("turn_start", (event: any) => {
    if (event?.turnIndex === 0 || event?.turnIndex === undefined) {
      pensarState.investigatedInTurn = false;
      pensarState.turnReadPaths.clear();
      pendingInvestigations.clear();
      pendingCreations.clear();
    }
  });

  pi.on("agent_start", () => {
    pensarState.investigatedInTurn = false;
    pensarState.turnReadPaths.clear();
    pendingInvestigations.clear();
    pendingCreations.clear();
  });

  // Session start: restore mental and operational state
  pi.on("session_start", async (_event: any, ctx: ExtensionContext) => {
    pensarState.investigatedInTurn = false;
    pensarState.turnReadPaths.clear();
    pensarState.createdPaths.clear();
    pensarState.sessionReadPaths.clear();
    pensarState.singleShot = false;
    pendingInvestigations.clear();
    pendingCreations.clear();

    // Reset mental state structures to prevent cross-session memory leak
    mentalState.thoughts = [];
    mentalState.hypotheses.clear();
    mentalState.premises.clear();
    mentalState.plans = [];
    mentalState.lastTask = undefined;

    let shouldBeActive = false;
    let shouldBeBoost = false;

    // Restore mental state from persisted session entries if available
    if (ctx?.sessionManager?.getEntries) {
      try {
        const entries = ctx.sessionManager.getEntries();
        for (const entry of entries) {
          if ((!entry.type || entry.type === "custom") && entry.customType === "pensar_mental_state" && entry.data) {
            const data = entry.data as any;
            if (typeof data.pensarActive === "boolean") {
              shouldBeActive = data.pensarActive;
            }
            if (typeof data.boostActive === "boolean") {
              shouldBeBoost = data.boostActive;
            }
            if (Array.isArray(data.hypotheses)) {
              for (const h of data.hypotheses) mentalState.hypotheses.add(h);
            }
            if (Array.isArray(data.premises)) {
              for (const p of data.premises) mentalState.premises.add(p);
            }
            if (Array.isArray(data.plans)) {
              for (const pl of data.plans) {
                if (!mentalState.plans.includes(pl)) mentalState.plans.push(pl);
              }
            }
            if (Array.isArray(data.recentThoughts)) {
              for (const th of data.recentThoughts) {
                if (!mentalState.thoughts.some(t => t.thought === th.thought && t.timestamp === th.timestamp)) {
                  mentalState.thoughts.push(th);
                }
              }
            }
            if (Array.isArray(data.investigatedFiles)) {
              for (const f of data.investigatedFiles) {
                const k = normalizePathKey(String(f));
                pensarState.sessionReadPaths.add(k);
                pensarState.turnReadPaths.add(k);
              }
            }
            if (Array.isArray(data.createdFiles)) {
              for (const f of data.createdFiles) {
                pensarState.createdPaths.add(normalizePathKey(String(f)));
              }
            }
            if (data.lastTask) {
              mentalState.lastTask = data.lastTask;
            }
          }
        }
      } catch {}
    }

    pensarState.active = shouldBeActive;
    pensarState.boostActive = shouldBeBoost;
    if (shouldBeActive || shouldBeBoost) {
      recalibrate(ctx.model, ctx);
    }
  });

  // Inject execution discipline and boost rules in before_agent_start
  pi.on("before_agent_start", (event: BeforeAgentStartEvent, _ctx: ExtensionContext): BeforeAgentStartEventResult | void => {
    if (!pensarState.active && !pensarState.boostActive) return;

    const sections: string[] = [];

    if (pensarState.boostActive) {
      sections.push(
        "[PROTOCOLO DE ORQUESTRAÇÃO ESTRUTURADA - BOOST ATIVO]\n" +
        "1. Exploração: Inspecione arquivos com 'read', 'grep', 'find' ou acione os subagentes 'scout'/'debug-investigator'/'librarian'.\n" +
        "2. Planejamento/Decomposição: Defina hipóteses e etapas atômicas (use 'think' em modelos não-nativos).\n" +
        "3. Execução Cirúrgica: Mutações pontuais; criação de novos arquivos legítimos permitida sem deadlock.\n" +
        "4. Verificação/Auditoria: Valide com testes automatizados e consulte 'code-quality-reviewer' quando apropriado."
      );
    }

    if (pensarState.active) {
      sections.push(
        "[DISCIPLINA DE REFLEXÃO - MODO PENSAR ATIVO]\n" +
        "1. Entenda antes de agir: identifique o objetivo, as restrições e qualquer informação realmente necessária.\n" +
        "2. Questione a primeira conclusão: quando houver ambiguidade relevante, considere ao menos uma explicação ou solução alternativa.\n" +
        "3. Verifique antes de afirmar: sustente conclusões com código, ferramentas ou resultados observáveis.\n" +
        "4. Revisão final silenciosa: confirme que respondeu ao pedido real, respeitou as evidências, concluiu o trabalho necessário e não excedeu o alcance da verificação."
      );
    }

    if (pensarState.active && !pensarState.isNative) {
      sections.push(
        "[DISCIPLINA COGNITIVA - MODO PENSAR ATIVO]\n" +
        "1. Scratchpad Estruturado: Use a ferramenta 'think' antes de qualquer tomada de decisão crítica, alteração ou execução.\n" +
        "2. Investigação Obrigatória: Inspecione arquivos com 'read', 'grep' ou 'find' antes de propor modificações.\n" +
        "3. Guardrail de Mutabilidade: Tentativas de editar ou escrever arquivos sem prévia investigação no turno serão bloqueadas.\n" +
        "4. Raciocínio Baseado em Evidências: Justifique suas conclusões com evidências concretas encontradas no código."
      );
    }

    if (sections.length === 0) return;

    const existingPrompt = event.systemPrompt || "";
    const newSections = sections.filter(s => !existingPrompt.includes(s.split("\n")[0]));
    if (newSections.length === 0) return;

    const combinedRules = newSections.join("\n\n");
    return {
      systemPrompt: existingPrompt ? `${existingPrompt}\n\n${combinedRules}` : combinedRules
    };
  });

  // Mutability guardrails: intercept tool_call to prevent blind mutations
  pi.on("tool_call", (event: ToolCallEvent, ctx: ExtensionContext): ToolCallEventResult | void => {
    if (!pensarState.active && !pensarState.boostActive) return;

    const toolName = event.toolName;

    // 1. Investigation subagents (task with scout, debug-investigator, librarian)
    if (isInvestigationTask(toolName, event.input)) {
      const inputPaths = extractPathsFromTaskInput(event.input);
      const normalizedPaths = inputPaths.map(normalizePathKey);
      const callId = (event as any).toolCallId || `${toolName}:${Date.now()}`;
      pendingInvestigations.set(callId, { paths: normalizedPaths, isTask: true });
      return;
    }

    const targetPath = extractTargetPath(event.input);
    const pathKey = targetPath ? normalizePathKey(targetPath) : "";

    // 2. Standard investigation tools (read, view_file, grep, find, ls, glob, list_dir)
    if (isInvestigationTool(toolName)) {
      const recorded = pathKey ? [pathKey] : [];
      const callId = (event as any).toolCallId || `${toolName}:${Date.now()}`;
      pendingInvestigations.set(callId, { paths: recorded, isTask: false });
      return;
    }

    // 3. Check if target path was already read/investigated or created in this turn/session
    const isPathRecorded = (key: string): boolean => {
      if (!key) return false;
      if (
        pensarState.turnReadPaths.has(key) ||
        pensarState.createdPaths.has(key) ||
        pensarState.sessionReadPaths.has(key)
      ) return true;

      // Handle drive letter variations: e.g. c:/workspace/src/app.ts vs /workspace/src/app.ts
      if (/^[a-z]:\//.test(key)) {
        const withoutDrive = key.slice(2);
        if (
          pensarState.turnReadPaths.has(withoutDrive) ||
          pensarState.createdPaths.has(withoutDrive) ||
          pensarState.sessionReadPaths.has(withoutDrive)
        ) return true;
      } else if (key.startsWith("/")) {
        for (const item of pensarState.turnReadPaths) {
          if (/^[a-z]:\//.test(item) && item.slice(2) === key) return true;
        }
        for (const item of pensarState.createdPaths) {
          if (/^[a-z]:\//.test(item) && item.slice(2) === key) return true;
        }
        for (const item of pensarState.sessionReadPaths) {
          if (/^[a-z]:\//.test(item) && item.slice(2) === key) return true;
        }
      }

      if (ctx?.cwd && typeof ctx.cwd === "string") {
        try {
          if (path.isAbsolute(targetPath)) {
            const relKey = normalizePathKey(path.relative(ctx.cwd, targetPath));
            if (
              pensarState.turnReadPaths.has(relKey) ||
              pensarState.createdPaths.has(relKey) ||
              pensarState.sessionReadPaths.has(relKey)
            ) return true;
          } else {
            const absKey = normalizePathKey(path.resolve(ctx.cwd, targetPath));
            if (
              pensarState.turnReadPaths.has(absKey) ||
              pensarState.createdPaths.has(absKey) ||
              pensarState.sessionReadPaths.has(absKey)
            ) return true;
            if (/^[a-z]:\//.test(absKey)) {
              const absWithoutDrive = absKey.slice(2);
              if (
                pensarState.turnReadPaths.has(absWithoutDrive) ||
                pensarState.createdPaths.has(absWithoutDrive) ||
                pensarState.sessionReadPaths.has(absWithoutDrive)
              ) return true;
            }
          }
        } catch {}
      }
      return false;
    };

    const isTargetInvestigated = pathKey ? isPathRecorded(pathKey) : false;

    if (isTargetInvestigated) {
      if (pathKey) {
        pensarState.turnReadPaths.add(pathKey);
      }
      return;
    }

    const lowerToolName = toolName.toLowerCase();

    // 4. File mutation tools (edit, write, patch, multiedit, write_to_file, replace_file_content, etc.)
    if (isFileMutationTool(toolName)) {
      // R3: For write tools, distinguish new file creation from overwriting existing file
      if (isFileWriteTool(toolName) && targetPath) {
        const isExisting = isExistingFile(String(targetPath), ctx?.cwd, ctx);
        if (!isExisting) {
          // Legitimate new file creation allowed (anti-deadlock)
          const callId = (event as any).toolCallId || `${lowerToolName}:${Date.now()}`;
          pendingCreations.set(callId, pathKey);
          return;
        }
      }

      return {
        block: true,
        reason: `Guardrail cognitivo (/pensar): Operação de mutação '${toolName}' bloqueada em arquivo existente` +
                (targetPath ? ` ('${targetPath}')` : "") + `. ` +
                `Nenhum arquivo relevante foi investigado ou lido neste turno. ` +
                `Por favor, utilize 'read', 'grep' ou 'find' para inspecionar os arquivos relevantes e planeje com 'think' antes de realizar alterações.`
      };
    }

    // 5. Shell mutation tools
    const shellTools = new Set([
      "bash", "powershell", "pwsh", "cmd", "sh", "exec", "terminal",
      "shell", "run_command", "exec_command", "execute_command",
      "command", "run", "terminal_run", "bash_command", "sh_command",
      "execute", "shell_command", "cli"
    ]);
    if (shellTools.has(lowerToolName)) {
      const cmd = extractCommand(event.input);
      if (isMutatingCommand(cmd) && !pensarState.investigatedInTurn) {
        return {
          block: true,
          reason: `Guardrail cognitivo (/pensar): Comando mutatório de shell bloqueado ('${cmd.length > 60 ? cmd.slice(0, 57) + "..." : cmd}'). ` +
                  `Nenhum arquivo ou contexto relevante foi investigado neste turno. ` +
                  `Por favor, inspecione os arquivos e o ambiente antes de aplicar modificações.`
        };
      } else if (isInvestigationCommand(cmd)) {
        const callId = event.toolCallId;
        pendingInvestigations.set(callId, { paths: [], isTask: false, isShell: true });
      }
    }
  });

  // Listen for tool_result to capture investigated paths from subagents and tools
  pi.on("tool_result", (event: ToolResultEvent, _ctx: ExtensionContext) => {
    if (!pensarState.active && !pensarState.boostActive) return;

    const toolName = event.toolName;
    const lowerToolName = toolName.toLowerCase();
    const isTask = lowerToolName === "task" ||
                   lowerToolName === "agent_task" ||
                   lowerToolName === "subagent" ||
                   lowerToolName === "delegate" ||
                   lowerToolName === "run_agent" ||
                   lowerToolName === "spawn_agent" ||
                   lowerToolName === "sub_agent";
    const isInvTool = isInvestigationTool(toolName);
    const shellTools = new Set([
      "bash", "powershell", "pwsh", "cmd", "sh", "exec", "terminal",
      "shell", "run_command", "exec_command", "execute_command",
      "command", "run", "terminal_run", "bash_command", "sh_command",
      "execute", "shell_command", "cli"
    ]);
    const isShell = shellTools.has(lowerToolName);

    if (event.isError) {
      const callId = event.toolCallId;
      let pending = callId ? pendingInvestigations.get(callId) : undefined;
      if (!pending) {
        for (const [k, v] of pendingInvestigations.entries()) {
          if (isTask && v.isTask) {
            pending = v;
            pendingInvestigations.delete(k);
            break;
          } else if (isShell && v.isShell) {
            pending = v;
            pendingInvestigations.delete(k);
            break;
          } else if (k.toLowerCase().startsWith(lowerToolName)) {
            pending = v;
            pendingInvestigations.delete(k);
            break;
          }
        }
      } else {
        pendingInvestigations.delete(callId);
      }


      pendingCreations.delete(callId);

      return;
    }

    const createdPath = pendingCreations.get(event.toolCallId);
    pendingCreations.delete(event.toolCallId);
    if (createdPath) {
      pensarState.createdPaths.add(createdPath);
      pensarState.turnReadPaths.add(createdPath);
    }

    const pending = pendingInvestigations.get(event.toolCallId);
    pendingInvestigations.delete(event.toolCallId);
    if (!pending) return;

    const paths = new Set([...pending.paths, ...extractPathsFromToolResult(event)]);
    for (const investigatedPath of paths) {
      pensarState.turnReadPaths.add(normalizePathKey(investigatedPath));
    }
    pensarState.investigatedInTurn = true;
  });

  // Mental state preservation on compaction
  pi.on("session_before_compact", (event: SessionBeforeCompactEvent, _ctx: ExtensionContext): SessionBeforeCompactResult | void => {
    if (
      !pensarState.active && !pensarState.boostActive &&
      mentalState.thoughts.length === 0 &&
      !mentalState.lastTask &&
      mentalState.hypotheses.size === 0 &&
      mentalState.premises.size === 0 &&
      mentalState.plans.length === 0 &&
      pensarState.turnReadPaths.size === 0 &&
      pensarState.createdPaths.size === 0 &&
      pensarState.sessionReadPaths.size === 0
    ) return;

    const payload = {
      timestamp: Date.now(),
      pensarActive: pensarState.active,
      boostActive: pensarState.boostActive,
      mode: pensarState.active ? (pensarState.isNative ? "native" : "scratchpad") : "inactive",
      thinkingLevel: pi.getThinkingLevel(),
      lastTask: mentalState.lastTask,
      recentThoughts: mentalState.thoughts.slice(-10),
      hypotheses: Array.from(mentalState.hypotheses),
      premises: Array.from(mentalState.premises),
      plans: mentalState.plans.slice(-5),
      investigatedFiles: Array.from(new Set([...pensarState.sessionReadPaths, ...pensarState.turnReadPaths])),
      createdFiles: Array.from(pensarState.createdPaths),
      summary: "Estado mental do modo /pensar preservado antes da compactação para continuidade cognitiva."
    };

    try {
      pi.appendEntry("pensar_mental_state", payload);
    } catch {}

    const mentalSummary = [
      "[PRESERVAÇÃO COGNITIVA /PENSAR]",
      `Modo: ${payload.mode}`,
      payload.boostActive ? "Boost: ativo" : "",
      payload.lastTask ? `Tarefa analisada: ${payload.lastTask}` : "",
      payload.hypotheses.length > 0 ? `Hipóteses ativas: ${payload.hypotheses.join("; ")}` : "",
      payload.premises.length > 0 ? `Premissas chave: ${payload.premises.join("; ")}` : "",
      payload.plans.length > 0 ? `Plano atual: ${payload.plans[payload.plans.length - 1]}` : ""
    ].filter(Boolean).join("\n");

    let existingInstructions = (event.customInstructions || "").trim();
    existingInstructions = existingInstructions.replace(/\[PRESERVAÇÃO COGNITIVA \/PENSAR\][\s\S]*?(?=(?:\n\n\[)|$)/g, "").trim();
    const customInstructions = existingInstructions
      ? `${existingInstructions}\n\n${mentalSummary}`
      : mentalSummary;

    return { customInstructions };
  });
}
