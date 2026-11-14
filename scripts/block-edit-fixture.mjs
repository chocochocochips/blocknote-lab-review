/** F05-03 synthetic trial only. Never reads a real device document. */
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';import {join} from 'node:path';
import {initializeWorkspace} from '../server/workspace.mjs';
if(!process.argv[2]){console.error('Usage: node scripts/block-edit-fixture.mjs NEW_TEST_DESTINATION');process.exitCode=1;}
else{
 const source=mkdtempSync(join(tmpdir(),'f503-synthetic-'));
 try{
  const paragraph=(id,text)=>({id,type:'paragraph',props:{},content:[{type:'text',text,styles:{}}],children:[]});
  const d={id:'f503-android-synthetic',revision:7,updatedAt:'2026-11-01T00:00:00.000Z',blocks:[
   paragraph('f503-first','이것은 AI 문단 수정 기능을 시험하기 위한 첫 번째 문단입니다. 더 읽기 쉽게 다듬어 보세요.'),
   paragraph('f503-second','이 두 번째 문단은 첫 문단 수정 이후에도 그대로 남아 있어야 합니다.'),
   {...paragraph('f503-heading','일반 문단만 수정할 수 있습니다.'),type:'heading',props:{level:2}},
  ]};
  writeFileSync(join(source,'document.json'),JSON.stringify(d,null,2));writeFileSync(join(source,'history.jsonl'),'');
  console.log(JSON.stringify(initializeWorkspace({destination:process.argv[2],source,title:'F05-03 문단 수정 시험'}),null,2));
 }catch(e){console.error(e.message);process.exitCode=1;}
 finally{rmSync(source,{recursive:true,force:true});}
}
