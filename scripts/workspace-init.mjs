import { initializeWorkspace } from '../server/workspace.mjs';
const [destination, source] = process.argv.slice(2);
if (!destination) { console.error('Usage: node scripts/workspace-init.mjs NEW_DESTINATION [SYNTHETIC_SOURCE_COPY]'); process.exitCode = 1; }
else { try { console.log(JSON.stringify(initializeWorkspace({ destination, source }), null, 2)); } catch (e) { console.error(e.message); process.exitCode = 1; } }
