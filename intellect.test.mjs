import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import ts from 'typescript';
const require = createRequire(import.meta.url);
const compiled = ts.transpileModule(fs.readFileSync(new URL('./intellect.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const mod = { exports: {} };
vm.runInNewContext(compiled, { exports: mod.exports, module: mod, require, console, process, Date, Set, Map });
const extension = mod.exports;
async function harness(t) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'intellect-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  fs.writeFileSync(path.join(cwd, 'a.ts'), 'export const a = 1;\n');
  fs.writeFileSync(path.join(cwd, 'b.ts'), 'export const b = 1;\n');
  const handlers = {}, commands = {};
  let tools = ['read', 'edit', 'bash', 'write'];
  extension.default({ on: (name, fn) => { handlers[name] = fn; }, registerTool() {}, registerCommand: (name, command) => { commands[name] = command; }, getActiveTools: () => tools, setActiveTools: value => { tools = value; }, setThinkingLevel() {}, getThinkingLevel: () => 'high' });
  const ctx = { cwd, model: { reasoning: true }, ui: { notify() {}, setStatus() {} } };
  await commands.intellect.handler('on', ctx);
  let id = 0;
  const call = (toolName, input) => {
    const event = { toolName, input, toolCallId: String(++id) };
    return { event, decision: handlers.tool_call(event, ctx) };
  };
  const result = (event, text, isError = false) => handlers.tool_result({ ...event, isError, content: [{ type: 'text', text }] }, ctx);
  const read = (file = 'a.ts') => { const { event } = call('read', { path: file + ':1-10' }); result(event, `[${file}#ABCD]\n1:export const a = 1;`); };
  const edit = (file = 'a.ts') => call('edit', { input: `[${file}#ABCD]\nPUT 1.=1:\n+export const a = 2;` }).decision;
  return { cwd, handlers, ctx, call, result, read, edit };
}
test('anchored editor recovers after a blocked attempt and successful read', async t => {
  const h = await harness(t); assert.equal(h.edit()?.block, true); h.read(); assert.equal(h.edit(), undefined);
});
test('intervening reads and lifecycle events preserve unchanged evidence', async t => {
  const h = await harness(t); h.read(); h.read('b.ts'); h.handlers.turn_start({}); h.handlers.agent_settled({}, h.ctx); h.handlers.agent_start(); assert.equal(h.edit(), undefined);
});
test('changed file is rejected until read again', async t => {
  const h = await harness(t); h.read(); fs.writeFileSync(path.join(h.cwd, 'a.ts'), 'export const a = 3;');
  assert.match(h.edit()?.reason ?? '', /INTELLECT_FILE_CONTEXT_STALE/); h.read(); assert.equal(h.edit(), undefined);
});
test('Codegraph source counts but path mentions do not', async t => {
  const h = await harness(t);
  let c = h.call('mcp__codegraph_explore', { query: 'a.ts' }); h.result(c.event, 'Referenced file: a.ts'); assert.equal(h.edit()?.block, true);
  c = h.call('mcp__codegraph_explore', { query: 'a.ts' }); h.result(c.event, '## a.ts\n```typescript\n1\texport const a = 1;\n```'); assert.equal(h.edit(), undefined);
});
test('guidance never requires absent think or find tools', async t => {
  const h = await harness(t); assert.doesNotMatch(h.edit().reason, /'think'|'find'/); assert.match(h.edit().reason, /a\.ts/);
});
test('git inspection arguments are not interpreted as executable commands', () => {
  for (const command of ['git diff -- README.md', 'git show HEAD:src/remove.ts', 'git status', 'git branch --show-current', 'git rev-parse HEAD', 'git ls-files']) assert.equal(extension.isMutatingCommand(command), false, command);
  for (const command of ['git restore a.ts', 'git -C repo restore a.ts', 'git diff -- a.ts && git restore a.ts', 'git diff > patch.txt']) assert.equal(extension.isMutatingCommand(command), true, command);
});
test('multi-file edits require fresh evidence for every target', async t => {
  const h = await harness(t); h.read(); const input = '[a.ts#ABCD]\nPUT 1.=1:\n+x\n[b.ts#ABCD]\nPUT 1.=1:\n+y';
  assert.equal(h.call('edit', { input }).decision?.block, true); h.read('b.ts'); assert.equal(h.call('edit', { input }).decision, undefined);
});
test('failed reads cannot unlock mutations', async t => {
  const h = await harness(t); const c = h.call('read', { path: 'a.ts' }); h.result(c.event, 'read failed', true); assert.equal(h.edit()?.block, true);
});
test('parallel read results are correlated by call ID', async t => {
  const h = await harness(t);
  const a = h.call('read', { path: 'a.ts' }); const b = h.call('read', { path: 'b.ts' });
  h.result(b.event, 'export const b = 1;'); h.result(a.event, 'error', true);
  assert.equal(h.edit('b.ts'), undefined); assert.equal(h.edit('a.ts')?.block, true);
});
test('device Codegraph source unlocks edits without treating dispatch as a file write', async t => {
  const h = await harness(t); const c = h.call('write', { path: 'xd://mcp__codegraph_explore', content: '{"query":"a.ts"}' });
  assert.equal(c.decision, undefined); h.result(c.event, '[a.ts#ABCD]\n1:export const a = 1;'); assert.equal(h.edit(), undefined);
});
test('new files are allowed but existing-file overwrite needs a read', async t => {
  const h = await harness(t);
  assert.equal(h.call('write', { path: 'new.ts', content: 'x' }).decision, undefined);
  assert.equal(h.call('write', { path: 'a.ts', content: 'x' }).decision?.block, true);
  h.read(); assert.equal(h.call('write', { path: 'a.ts', content: 'x' }).decision, undefined);
});
test('file changing while a read is in flight does not establish fresh evidence', async t => {
  const h = await harness(t); const c = h.call('read', { path: 'a.ts' });
  fs.writeFileSync(path.join(h.cwd, 'a.ts'), 'changed'); h.result(c.event, 'old source'); assert.equal(h.edit()?.block, true);
});
