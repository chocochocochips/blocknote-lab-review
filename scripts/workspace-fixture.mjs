/** Generates SYNTHETIC Revision 7 only; no real device path is read. */
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {initializeWorkspace} from '../server/workspace.mjs';
export function createSyntheticWorkspace(destination) {
 if(!destination) throw Error('A new synthetic destination is required');
 const source=mkdtempSync(join(tmpdir(),'blocknote-f05-synthetic-'));
 try {
  const doc={id:'f05-synthetic-rev7',revision:7,updatedAt:'2026-11-01T00:00:00.000Z',blocks:[{id:'synthetic-intro',type:'paragraph',props:{},content:[{type:'text',text:'F05-02 합성 시험 문서입니다. 실제 Revision 7 원본이 아닙니다.',styles:{}}],children:[]}]};
  writeFileSync(join(source,'document.json'),JSON.stringify(doc,null,2));
  writeFileSync(join(source,'history.jsonl'),JSON.stringify({revision:7,at:doc.updatedAt,actor:'synthetic-fixture',operation:'document.save',transactionId:'synthetic-revision-seven'})+'\n');
  return initializeWorkspace({destination,source,title:'시험 문서 · Rev 7'});
 }finally{rmSync(source,{recursive:true,force:true});}
}


if (process.argv[1] && import.meta.url === new URL('file://' + process.argv[1]).href) {
 try { console.log(JSON.stringify(createSyntheticWorkspace(process.argv[2]),null,2)); }
 catch { console.error('Synthetic fixture creation failed; destination must be new.'); process.exitCode=1; }
}
