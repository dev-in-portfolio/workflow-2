const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { createWorkflowSupervisor } = require('../src/workflow-supervisor');
const { resolveRepoRoot } = require('../src/util');

async function main(argv = process.argv.slice(2)) {
  const action = String(argv[0] || 'status').toLowerCase();
  const repoRoot = resolveRepoRoot();
  const statePath = path.join(repoRoot, 'data', 'runtime', 'workflow-supervisor.json');
  if (action === 'status') {
    let state = {}; try { state = JSON.parse(fs.readFileSync(statePath, 'utf8')); } catch { /* no supervisor state yet */ }
    const assessed = assessWorkflowState(state);
    process.stdout.write(`${JSON.stringify(assessed, null, 2)}\n`);
    return assessed.status === 'healthy' ? 0 : 1;
  }
  if (action === 'start' && !argv.includes('--foreground')) {
    const state = readState(statePath);
    if (state.supervisor_pid && isPidAlive(state.supervisor_pid) && ['starting', 'healthy', 'recovering'].includes(state.status)) {
      process.stdout.write(`Workflow supervisor already running (PID ${state.supervisor_pid}).\n`);
      return 0;
    }
    const logs = path.join(repoRoot, 'data', 'logs'); fs.mkdirSync(logs, { recursive: true });
    const outPath = path.join(logs, 'workflow-launch.out.log');
    const errPath = path.join(logs, 'workflow-launch.err.log');
    const outFd = fs.openSync(outPath, 'a');
    const errFd = fs.openSync(errPath, 'a');
    const command = `${process.execPath} ${__filename} start --foreground`;
    const child = spawn(process.execPath, [__filename, 'start', '--foreground'], { cwd: repoRoot, detached: true, windowsHide: true, stdio: ['ignore', outFd, errFd] });
    try { await waitForSpawn(child); } catch (error) {
      process.stderr.write(`Workflow supervisor launch failed. Command: ${command}. Code: ${error.code || 'unknown'}. Error: ${error.message}. Log: ${errPath}\n`);
      return 1;
    } finally {
      fs.closeSync(outFd); fs.closeSync(errFd);
    }
    child.unref(); process.stdout.write(`Workflow supervisor launched (PID ${child.pid}). Command: ${command}. Logs: ${outPath}, ${errPath}\n`); return 0;
  }
  const supervisor = createWorkflowSupervisor({ repoRoot });
  if (action === 'stop') {
    const previous = readState(statePath);
    const result = await supervisor.stop();
    if (previous.supervisor_pid && Number(previous.supervisor_pid) !== process.pid && isPidAlive(previous.supervisor_pid)) {
      await killTree(previous.supervisor_pid);
    }
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return result.ok ? 0 : 1;
  }
  if (action === 'restart') {
    const previous = readState(statePath);
    const stopped = await supervisor.stop();
    if (previous.supervisor_pid && Number(previous.supervisor_pid) !== process.pid && isPidAlive(previous.supervisor_pid)) {
      await killTree(previous.supervisor_pid);
    }
    if (!stopped.ok) return 1;
    return main(['start']);
  }
  const result = await supervisor.start();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (action === 'start' && argv.includes('--foreground') && result.ok) await new Promise(() => {});
  return result.ok ? 0 : 1;
}
function readState(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; } }
function isPidAlive(pid) { try { process.kill(Number(pid), 0); return true; } catch { return false; } }
function assessWorkflowState(state = {}, pidAlive = isPidAlive) {
  const services = state.services || {};
  const issues = [];
  if (!state.supervisor_pid || !pidAlive(state.supervisor_pid)) issues.push('SUPERVISOR_PROCESS_NOT_RUNNING');
  for (const name of ['trader', 'scanner', 'dashboard']) {
    const service = services[name] || {};
    if (service.status !== 'running' || !service.pid || !pidAlive(service.pid)) {
      issues.push(`${name.toUpperCase()}_PROCESS_NOT_RUNNING`);
    }
  }
  if (!issues.length && state.status === 'healthy') return { ...state, health_verified: true, health_issues: [] };
  return {
    ...state,
    status: state.status === 'stopped' ? 'stopped' : 'degraded',
    health_verified: false,
    health_issues: issues,
  };
}
function waitForSpawn(child) { return new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); }); }
async function killTree(pid) {
  if (!isPidAlive(pid)) return;
  await new Promise((resolve) => {
    const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    killer.once('exit', resolve);
    killer.once('error', resolve);
  });
}
if (require.main === module) main().then((code) => { process.exitCode = code; }).catch((error) => { process.stderr.write(`${error.stack || error}\n`); process.exitCode = 1; });
module.exports = { main, assessWorkflowState };
