import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

test('B10-02: no new heading/body type controls beyond the recorded PR27 legacy dropdown',()=>{
 const app=readFileSync(new URL('../client/src/App.jsx',import.meta.url),'utf8');
 // Baseline debt is explicit: one existing custom selector. This does NOT assert
 // that complete absence has been achieved; removal needs separate authorization.
 const typeMenus=[...app.matchAll(/<select\b[^>]*>([\s\S]*?)<\/select>/g)].filter(m=>/<option\s+value="heading"/.test(m[1]));
 assert.equal(typeMenus.length,1,'do not add or duplicate type menus');
 assert.deepEqual([...typeMenus[0][1].matchAll(/<option value="([^"]+)"[^>]*>([^<]+)<\/option>/g)].map(m=>[m[1],m[2]]),[
  ['paragraph','본문'],['heading','제목'],['bulletListItem','목록'],['numberedListItem','번호 목록'],['quote','인용']
 ]);
 const headingButtons=[...app.matchAll(/<button\b[^>]*[\s\S]*?<\/button>/g)].filter(m=>/aria-label="(?:제목(?: [123])?|본문)"/.test(m[0])||/>\s*(?:제목(?: [123])?|본문)\s*<\/button>/.test(m[0]));
 assert.equal(headingButtons.length,0,'do not introduce title/body conversion buttons');
});
