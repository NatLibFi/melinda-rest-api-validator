import assert from 'node:assert';
import {after, before, describe, it} from 'node:test';
import {spawn} from 'node:child_process';
import net from 'node:net';
import path from 'node:path';

// Intentionally untested wiring: that `startApp(config)` is called with the
// loaded module-level config. Verifying this requires a module mock or a src
// refactor (no seam exists for src/index.js); the signal and rejection paths
// below prove the handler registration and the run() -> startApp() wiring
// actually execute.

const INDEX_PATH = path.join(import.meta.dirname, 'index.js');

// RECORD_TYPE + SRU_URL are mandatory for importing src/config.js.
const BASE_ENV = {RECORD_TYPE: 'bib', SRU_URL: 'http://sru.test'};

// Runs src/index.js in a subprocess and resolves with its exit code and
// combined output. Optionally kills the child after a delay so signal
// handlers can be exercised while the app loop is pending.
const runIndex = (env, {signalAfterMs = null, signal = null} = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [INDEX_PATH], {env: {...process.env, ...env}});
    let output = '';
    child.stdout.on('data', (chunk) => {output += chunk;});
    child.stderr.on('data', (chunk) => {output += chunk;});
    if (signalAfterMs) {
      const timer = setTimeout(() => child.kill(signal), signalAfterMs);
      timer.unref();
    }
    // Hard-kill safety net: no test may ever orphan a child. Unref'd so it
    // cannot itself keep the process alive; cleared when the child exits.
    const killTimer = setTimeout(() => child.kill('SIGKILL'), 20000);
    killTimer.unref();
    child.on('exit', (exitCode) => {
      clearTimeout(killTimer);
      // Belt-and-braces: kill once more in case the child lingered.
      child.kill('SIGKILL');
      resolve({exitCode, output});
    });
    child.on('error', reject);
  });

describe('index (subprocess: process entry wiring)', () => {
  // A dumb TCP socket that accepts but never answers: mongoFactory's
  // client.connect() hangs on it, keeping the app alive so the signal
  // handlers can be exercised.
  let socketServer;
  let mongoUri;
  const liveSockets = new Set();

  before(async () => {
    socketServer = net.createServer();
    socketServer.on('connection', (socket) => {
      liveSockets.add(socket);
      socket.on('close', () => liveSockets.delete(socket));
    });
    await new Promise((resolve) => socketServer.listen(0, '127.0.0.1', resolve));
    mongoUri = `mongodb://127.0.0.1:${socketServer.address().port}/db`;
  });
  after(() => new Promise((resolve) => {
    // A child killed mid-handshake leaves a half-open server socket behind
    // (it never sees EOF), which server.close() would wait on forever.
    for (const socket of liveSockets) {
      socket.destroy();
    }
    socketServer.close(resolve);
  }));

  it('exits with code 1 and logs the signal on SIGTERM', async () => {
    const {exitCode, output} = await runIndex({...BASE_ENV, MONGO_URI: mongoUri},
      {signalAfterMs: 3000, signal: 'SIGTERM'});
    assert.strictEqual(exitCode, 1);
    assert.ok(output.includes('Received SIGTERM'), `output was:\n${output}`);
  });

  it('exits with code 1 and logs the signal on SIGINT', async () => {
    const {exitCode, output} = await runIndex({...BASE_ENV, MONGO_URI: mongoUri},
      {signalAfterMs: 3000, signal: 'SIGINT'});
    assert.strictEqual(exitCode, 1);
    assert.ok(output.includes('Received SIGINT'), `output was:\n${output}`);
  });

  it('exits with code 1 when startApp rejects (unhandled rejection path)', async () => {
    // Connection-refused on 127.0.0.1:1 is immediate; the explicit short
    // serverSelectionTimeoutMS makes the failure deterministic anyway.
    const {exitCode, output} = await runIndex(
      {...BASE_ENV, MONGO_URI: 'mongodb://127.0.0.1:1/db?serverSelectionTimeoutMS=2000'});
    assert.strictEqual(exitCode, 1);
    assert.ok(output.includes('MongoServerSelectionError: connect ECONNREFUSED 127.0.0.1:1'),
      `output was:\n${output}`);
  });
});
