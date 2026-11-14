import test from 'node:test';import assert from 'node:assert/strict';
import {orderedDocuments,moveId,fontSize,readPreference,writePreference} from '../client/src/appearance.mjs';
import {validateBlocks} from '../server/validation.mjs';
test('document preference ordering handles new/stale IDs without mutating server order',()=>{
 const docs=[{id:'a'},{id:'b'},{id:'c'}],snapshot=structuredClone(docs);
 assert.deepEqual(orderedDocuments(docs,['deleted','b','a']).map(x=>x.id),['b','a','c']);assert.deepEqual(docs,snapshot);
 assert.deepEqual(moveId(['a','b','c'],'a','c'),['b','c','a']);assert.deepEqual(moveId(['a','b'],'missing','a'),['a','b']);
});
test('unavailable or corrupt browser storage never breaks document editing',()=>{
 assert.equal(readPreference('missing','desk'),'desk');assert.equal(writePreference('missing',[]),false);
});
test('font size is bounded; additive inline style, nested children, rich links remain valid v0.2 blocks',()=>{
 assert.equal(fontSize(100),36);assert.equal(fontSize(-10),12);assert.equal(fontSize('invalid'),17);
 const block={id:'root',type:'paragraph',props:{},content:[{type:'text',text:'서식',styles:{bold:true,fontSize:'24'}},{type:'link',href:'https://example.com',content:[{type:'text',text:'링크',styles:{italic:true,fontSize:'20'}}]}],children:[{id:'child',type:'quote',props:{},content:[],children:[]}]};
 assert.equal(validateBlocks([block]).count,2);assert.deepEqual(JSON.parse(JSON.stringify(block)),block);
});
