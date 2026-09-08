# OMP Cognitive Modes

An extension for [Oh My Pi](https://github.com/can1357/oh-my-pi) that adds two independent cognitive modes to the agent:

- `🧠 Pensar [Ativo]`: increases reasoning effort and applies lightweight reflection, evidence gathering, and final-review discipline.
- `🚀 Boost [Ativo]`: structures complex work into investigation, planning, execution, and verification.

Both modes can remain active at the same time. Turning one mode on or off does not affect the other.

> The command names and status labels remain in Portuguese because they are part of the extension's interface.

## Requirements

- Node.js 22.19 or later
- Oh My Pi with TypeScript extension support

## Installation

Copy `pensar.ts` to OMP's global extensions directory:

### Windows

```powershell
New-Item -ItemType Directory -Force "$HOME\.omp\agent\extensions"
Copy-Item .\pensar.ts "$HOME\.omp\agent\extensions\pensar.ts"
```

### Linux and macOS

```bash
mkdir -p ~/.omp/agent/extensions
cp pensar.ts ~/.omp/agent/extensions/pensar.ts
```

If OMP is already running, execute `/reload` or restart it.

You can also load the extension directly:

```bash
omp -e ./pensar.ts
```

## Usage

### Pensar

Enter `/pensar` to toggle the mode:

```text
/pensar
```

While active, the agent:

1. identifies the goal and constraints before acting;
2. challenges its first conclusion when relevant ambiguity exists;
3. verifies evidence before making claims;
4. silently reviews the response before delivering it.

The command also supports explicit state changes and one-off tasks:

```text
/pensar on
/pensar off
/pensar investigate and fix this error
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

### Using both modes

```text
/pensar
/boost
```

The status bar displays both indicators. In this state, Pensar improves the reasoning process while Boost structures execution.

## Safety

The extension applies guardrails against premature changes: existing files must be successfully investigated before they can be modified. Tool and subagent results are correlated before mutations are allowed.

The extension contains no keys, tokens, or credentials.

## Development

```bash
npm install
npm run typecheck
```

Both commands live in `pensar.ts` because they share cognitive state, model integration, and mutation guardrails.
