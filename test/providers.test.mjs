import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CodexSession, readCodexConversation } from '../src/codex.mjs';
import { createSession, paneSession } from '../src/providers.mjs';
import { isAgentPane } from '../src/lib.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentpanel-test-'));
process.env.CODEX_HOME = path.join(root, 'codex');
process.env.CLAUDE_CONFIG_DIR = path.join(root, 'claude');
const dir = path.join(process.env.CODEX_HOME, 'sessions/2026/09/29');
fs.mkdirSync(dir, { recursive: true });
const entry = (type, payload) => JSON.stringify({ timestamp: new Date().toISOString(), type, payload }) + '\n';
const msg = (role, text, rest = {}) => entry('response_item', { type: 'message', role, content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }], ...rest });
const call = (id, name, args) => entry('response_item', { type: 'function_call', call_id: id, name, arguments: JSON.stringify(args) });
const result = (id, output) => entry('response_item', { type: 'function_call_output', call_id: id, output: JSON.stringify(output) });
const file = path.join(dir, 'rollout-parent.jsonl');
fs.writeFileSync(file,
  entry('session_meta', { id: 'parent', cwd: root }) +
  msg('developer', 'Private instructions') + msg('user', '<environment_context>private</environment_context>') +
  msg('user', 'Please fix this') +
  msg('assistant', 'Read https://example.com/plan\nACTION: Review the plan') +
  entry('event_msg', { type: 'agent_message', message: 'Read https://example.com/plan' }) +
  call('shell', 'exec_command', { cmd: 'false' }) + result('shell', { exit_code: 1 }) +
  call('spawn', 'spawn_agent', { message: 'Check the fix', agent_type: 'reviewer' }) + result('spawn', { agent_id: 'child' }));
const childFile = path.join(dir, 'rollout-child.jsonl');
fs.writeFileSync(childFile, entry('session_meta', { id: 'child', cwd: root, source: { subagent: { thread_spawn: { parent_thread_id: 'parent' } } } }) +
  entry('event_msg', { type: 'task_started' }) + msg('user', 'Check the fix') + msg('assistant', 'PROGRESS: 1/2 · checking'));
fs.writeFileSync(path.join(dir, 'rollout-other.jsonl'), entry('session_meta', { id: 'other', cwd: root }) + msg('user', 'Unrelated'));

test.after(() => fs.rmSync(root, { recursive: true, force: true }));
test('Codex messages, tools, refs, actions, live appends, and children', () => {
  const s = createSession('parent', 'codex'); s.refresh();
  assert.equal(s.provider, 'codex');
  assert.deepEqual(s.turns.map(m => m.text), ['Please fix this']);
  assert.equal(s.messages.length, 2);
  assert.equal(s.messages[1].role, 'codex');
  assert.equal(s.messages[1].cmds, 1);
  assert.equal(s.messages[1].errors, 1);
  assert.equal(s.messages[1].actions[0].summary, 'false');
  assert.equal(s.refs.size, 1);
  assert.equal(s.todos[0].text, 'Review the plan');
  assert.equal(s.list().length, 1);
  assert.equal(s.list()[0].progress.percent, 50);
  assert.equal(s.list()[0].status, 'running');
  s.refresh(); assert.equal(s.messages.length, 2);
  const next = msg('assistant', 'Done\nACTION: none', { phase: 'final_answer' });
  fs.appendFileSync(file, next.slice(0, -1)); s.refresh(); assert.equal(s.messages.length, 2);
  fs.appendFileSync(file, '\n'); s.refresh();
  assert.equal(s.todos.length, 0); assert.equal(s.messages.length, 3);
  fs.appendFileSync(childFile, msg('assistant', 'Verified', { phase: 'final_answer' }) + entry('event_msg', { type: 'task_complete' }));
  s.refresh(); assert.equal(s.list()[0].status, 'done');
  assert.equal(readCodexConversation(childFile).at(-1).text, 'Verified');
});
test('Codex custom patch calls mark edits and failed outputs', () => {
  const s = new CodexSession('unused', file); s.cwd = root;
  s.consume(JSON.parse(entry('response_item', { type: 'custom_tool_call', name: 'apply_patch', call_id: 'patch', input: '*** Begin Patch\n*** Update File: app.js\n*** End Patch' })));
  s.consume(JSON.parse(entry('response_item', { type: 'custom_tool_call_output', call_id: 'patch', output: 'Process exited with code 1' })));
  assert.equal(s.messages[0].edits, 1);
  assert.equal(s.messages[0].errors, 1);
  assert.ok(s.edited.has(path.join(root, 'app.js')));
});
test('pane selection supports both providers and excludes plugin panes', () => {
  assert.ok(isAgentPane({ agent: 'codex' })); assert.ok(isAgentPane({ agent: 'claude' }));
  assert.ok(!isAgentPane({ agent: 'codex', label: 'agentpanel' })); assert.ok(!isAgentPane({ agent: 'other' }));
  assert.equal(paneSession({ agent: 'codex', terminal_title_stripped: 'unrelated', agent_session: { value: 'parent' } }), 'parent');
});
test('Claude provider still reads messages and tool results', () => {
  const project = path.join(process.env.CLAUDE_CONFIG_DIR, 'projects/test'); fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(project, 'claude-test.jsonl'), [
    { type: 'user', message: { content: 'Hello Claude' } },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'Hello' }, { type: 'tool_use', id: 'c', name: 'Bash', input: { command: 'true' } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'c' }] } },
  ].map(e => JSON.stringify(e) + '\n').join(''));
  const s = createSession('claude-test'); s.refresh();
  assert.equal(s.turns.length, 1); assert.equal(s.messages.at(-1).role, 'claude');
  assert.equal(s.messages.at(-1).actions[0].result, 'ok');
});
