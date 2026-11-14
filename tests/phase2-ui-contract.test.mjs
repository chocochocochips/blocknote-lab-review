import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const app = readFileSync(new URL('../client/src/App.jsx', import.meta.url),'utf8');
const ai = readFileSync(new URL('../client/src/AiPanel.jsx', import.meta.url),'utf8');
const css = readFileSync(new URL('../client/src/phase2.css', import.meta.url),'utf8');
const entry = readFileSync(new URL('../client/src/main.jsx', import.meta.url),'utf8');

test('P2-01: themed design layer is loaded after existing styles',()=>{
  assert.match(entry,/import '\.\/styles\.css';\s*import '\.\/phase2\.css';/);
  assert.match(css,/--p2-bg:\s*#F5F2ED/);
  assert.match(css,/--p2-action:\s*#20221F/);
  assert.match(css,/--p2-green:\s*#205B46/);
});
test('P2-01: top announcement uses the existing 31px footprint',()=>{
  assert.match(app,/className="phase2-announcement"/);
  assert.match(css,/\.phase2-announcement\s*\{[^}]*height:31px;\s*min-height:31px;\s*max-height:31px;/);
});
test('P2-01: review stays visible and old save/restore entry points remain',()=>{
  assert.match(app,/className="phase2-ai-fixed"/);
  assert.match(css,/\.toolbar\.phase2-editor-toolbar \.phase2-ai-fixed/);
  assert.match(app,/if \(composing\.current \|\| discardInFlight\.current/);
  assert.match(app,/documentId: initial\.id, revision: revisionAtSave/);
  assert.match(app,/exportDocument\(\)/);
  assert.match(app,/restoreDocument\(payload\)/);
});
test('P2-01: opinion/edit modes are distinct and no browser research is falsely claimed',()=>{
  assert.match(ai,/setWorkspaceMode\('opinion'\)/);
  assert.match(ai,/setWorkspaceMode\('edit'\)/);
  assert.match(ai,/aria-pressed=\{workspaceMode==='opinion'\}/);
  assert.match(ai,/aria-pressed=\{workspaceMode==='edit'\}/);
  assert.doesNotMatch(ai,/웹 리서치·사실 확인 도구는 후속 연동 예정/);
  assert.match(ai,/<SkinPicker value=\{skin\} onChange=\{changeSkin\}/);
  assert.match(ai,/const approve=/);
});
test('P2-01: in-flight AI operations block accidental mode switches',()=>{
  assert.match(app,/if \(switching \|\| composing\.current \|\| !selectionGuard\.current\(\)\)/);
  assert.match(ai,/disabled=\{working\|\|running\|\|Boolean\(proposal\)\}/);
  assert.match(ai,/selectionGuard\.current=\(\)=>!/);
});

