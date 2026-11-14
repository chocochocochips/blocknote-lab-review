import { spawn } from 'node:child_process';
const options = { stdio: 'inherit', shell: process.platform === 'win32' };
const server = spawn(process.execPath, ['server/index.mjs'], options);
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const web = spawn(npm, ['run', 'web'], options);
let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  server.kill(); web.kill();
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
server.on('exit', (code) => { if (!stopping && code !== 0) { stop(); process.exitCode = code || 1; } });
web.on('exit', (code) => { if (!stopping && code !== 0) { stop(); process.exitCode = code || 1; } });
