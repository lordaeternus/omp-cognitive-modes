# OMP Cognitive Modes

An extension for [Oh My Pi](https://github.com/can1357/oh-my-pi) that adds two independent cognitive modes to the agent:

- `🧠 Intellect [Active]`: increases reasoning effort and applies lightweight reflection, evidence gathering, and final-review discipline.
- `🚀 Boost [Active]`: structures complex work into investigation, planning, execution, and verification.

Both modes can remain active at the same time. Turning one mode on or off does not affect the other.

## Requirements

- Node.js 22.19 or later
- Oh My Pi with TypeScript extension support

## Installation

Copy `intellect.ts` to OMP's global extensions directory:

### Windows

```powershell
New-Item -ItemType Directory -Force "$HOME\.omp\agent\extensions"
Copy-Item .\intellect.ts "$HOME\.omp\agent\extensions\intellect.ts"
```

### Linux and macOS

```bash
mkdir -p ~/.omp/agent/extensions
cp intellect.ts ~/.omp/agent/extensions/intellect.ts
```

If OMP is already running, execute `/reload` or restart it.

You can also load the extension directly:

```bash
omp -e ./intellect.ts
```

## Usage

### Intellect

Enter `/intellect` to toggle the mode:

```text
/intellect
```

While active, the agent:

1. identifies the goal and constraints before acting;
2. challenges its first conclusion when relevant ambiguity exists;
3. verifies evidence before making claims;
4. silently reviews the response before delivering it.

The command also supports explicit state changes and one-off tasks:

```text
/intellect on
/intellect off
/intellect investigate and fix this error
```

With native reasoning models, it selects the highest supported reasoning level. With other models, it enables the structured `think` tool.

### Boost

Enter `/boost` to toggle the mode:

```text
/boost
```

Boost structures execution into four stages:

1. investigation;
2. planning;
3. surgical execution;
4. verification and audit.

The command also supports explicit state changes and one-off tasks:

```text
/boost on
/boost off
/boost review this module and fix the problems you find
```

One-off tasks preserve an already continuous mode. Boost and Intellect have independent one-off lifetimes; completing or failing a Boost task does not disable Intellect. Disabling the last active mode restores the thinking level and scratchpad availability captured before activation.

### Using both modes

```text
/intellect
/boost
```

The status bar displays both indicators. In this state, Intellect improves the reasoning process while Boost structures execution.

## Safety

Existing-file edits and overwrites require a successful source read matching the file's current SHA-256 content. Evidence survives conversational turns but is cleared for a new session; changed files must be read again. Anchored patches check every file header. Read selectors and relative/absolute paths are normalized. Failed reads and files changed during a read do not establish evidence.

Codegraph source blocks with a file heading and numbered source lines count as inspection, including calls dispatched through `write` to its `xd://` device. Filename mentions, search listings, and subagent prose alone do not authorize edits. Block messages identify the file, known/current revisions, last accepted read, source tool, and a stable reason code.

Structural summaries without source do not authorize edits. Raw reads must match the complete file (allowing normalized line endings and an omitted final newline). Codegraph numbered source lines must match those same lines in the current local file; stale indexed source is rejected. This checks the returned excerpt, not the freshness of unreturned index metadata.

Git inspection commands are classified by subcommand rather than words in filenames. Mutating shell commands require fresh source context. This is a workflow aid, **not a sandbox or authorization system**: arbitrary programs, `eval`, and tool devices enforce their own contracts. The extension does not claim to intercept every possible write. User permission remains separate from technical evidence.

The extension contains no keys, tokens, or credentials.

## Development

```bash
npm install
npm run typecheck
node --test intellect.test.mjs
```

Both commands live in `intellect.ts` because they share cognitive state, model integration, and mutation guardrails.
