import { readFileSync } from 'node:fs';
import { verifyExport } from '../server/workspace.mjs';
try {
  if(!process.argv[2]) throw Error('Usage: node scripts/workspace-verify-export.mjs EXPORT.json');
  const {doc,events}=verifyExport(JSON.parse(readFileSync(process.argv[2],'utf8')));
  console.log(JSON.stringify({verified:true,documentId:doc.id,revision:doc.revision,historyEvents:events.length}));
} catch(e) { console.error(e.message); process.exitCode=1; }
