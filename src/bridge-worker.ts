import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { bridgeDeadline, python, root, type Request } from './client.ts';


/** `passEnv` names extra variables to hand the worker; tests use it for their protocol double's switches. */
export type Command = { python: string; args: string[]; passEnv?: string[] };
export type Options = { command?: Command; healthMs?: number; helloMs?: number; closeGraceMs?: number; deadlineMs?: number };

const MAX_LINE_BYTES = 8 * 1024 * 1024;

const ENV_ALLOWED = new Set(['PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'TMPDIR', 'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH',
  'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA', 'LANG', 'LC_ALL', 'TZ', 'PI_BROWSER_HARNESS_HOME']);
export function workerEnv(source: NodeJS.ProcessEnv = process.env, extra: string[] = []): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { PYTHONIOENCODING: 'utf-8' };
  for (const [key, value] of Object.entries(source)) if ((ENV_ALLOWED.has(key.toUpperCase()) || extra.includes(key)) && value !== undefined) env[key] = value;
  return env;
}
const DEFAULT_COMMAND: Command = { python, args: [join(root, 'python/bridge.py'), '--serve'] };
const EXTERNAL = 'external outcome uncertain. Inspect before retrying.';
const UNCERTAIN = 'outcome uncertain. Inspect before retrying.';
const TOO_LARGE = 'Response exceeds 8 MiB; outcome uncertain. Narrow the query before continuing.';

type Pending = { id: number; resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout; signal?: AbortSignal; onAbort?: () => void; onProgress?: (text: string) => void };
type State = 'running' | 'killed' | 'exited';

class Worker {
  state: State = 'running';
  private nextId = 1;
  private pending?: Pending;
  private chunks: Buffer[] = [];
  private bytes = 0;
  private exitCode: number | null = null;
  private resolveClosed!: () => void;
  private readonly closed = new Promise<void>(resolve => { this.resolveClosed = resolve; });

  constructor(readonly endpoint: string, private readonly child: ChildProcessWithoutNullStreams) {
    child.stdout.on('data', (chunk: Buffer) => this.onData(chunk));
    // external: Python diagnostics can contain page content and must not be surfaced.
    child.stderr.resume();
    child.stdin.on('error', () => this.kill(`Bridge input delivery failed; ${EXTERNAL}`));
    child.once('error', error => this.kill(`Bridge worker failed: ${error.message}; ${UNCERTAIN}`));
    // external: Node close fires after stdout drains, unlike exit.
    child.once('close', code => {
      this.exitCode = code;
      if (this.state === 'running') this.state = 'exited';
      this.settle(new Error(`Bridge worker exited during the request; ${UNCERTAIN}`));
      this.resolveClosed();
    });
    // external: Node stdio pipes can keep the event loop alive after the idle worker is unrefed.


    child.unref();
    for (const stream of [child.stdin, child.stdout, child.stderr]) (stream as unknown as { unref?: () => void }).unref?.();
  }

  get alive() { return this.state === 'running'; }

  static async start(command: Command, endpoint: string, helloMs: number, daemon: string): Promise<Worker> {
    if (!existsSync(command.python)) throw new Error(`Runtime missing. Run npm run setup in ${root}`);
    const child = spawn(command.python, command.args, {
      cwd: root, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: { ...workerEnv(process.env, command.passEnv), PI_BROWSER_HARNESS_DAEMON: daemon },
    });
    const worker = new Worker(endpoint, child);
    try {
      await worker.request({ control: 'hello', endpoint }, helloMs);
    } catch (error) {
      worker.kill('Bridge worker did not start.');
      throw error;
    }
    return worker;
  }


  request(payload: Record<string, unknown>, deadlineMs: number, signal?: AbortSignal, onProgress?: (text: string) => void): Promise<any> {
    if (signal?.aborted) return Promise.reject(new Error('Aborted before dispatch'));
    if (!this.alive) return Promise.reject(new Error(`Bridge worker is not running; ${UNCERTAIN}`));
    if (this.pending) return Promise.reject(new Error('Bridge worker busy; serialize interactions.'));
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const pending: Pending = { id, resolve, reject, signal, onProgress, timer: setTimeout(() => this.kill(`Deadline exceeded; ${EXTERNAL}`), deadlineMs) };
      if (signal) {
        pending.onAbort = () => this.kill(`Aborted; ${EXTERNAL}`);
        signal.addEventListener('abort', pending.onAbort, { once: true });
      }
      this.pending = pending;
      this.child.stdin.write(JSON.stringify({ ...payload, id }) + '\n', error => {
        if (error) this.kill(`Bridge input delivery failed; ${EXTERNAL}`);
      });
    });
  }


  async end(graceMs: number): Promise<'ended' | 'killed'> {
    if (!this.alive) return 'killed';
    this.child.stdin.end();
    const timer = setTimeout(() => this.kill(`Bridge worker did not exit after close; ${UNCERTAIN}`), graceMs);
    await this.closed;
    clearTimeout(timer);
    return this.state === 'exited' && this.exitCode === 0 ? 'ended' : 'killed';
  }


  kill(reason: string) {
    if (this.state !== 'running') return;
    this.state = 'killed';
    this.child.stdin.destroy();
    this.child.kill();
    // external: A process that never spawned emits no close event.
    if (this.child.pid === undefined) this.resolveClosed();
    this.settle(new Error(reason));
  }

  private settle(error?: Error, value?: unknown) {
    const pending = this.pending;
    if (!pending) return;
    this.pending = undefined;
    clearTimeout(pending.timer);
    if (pending.signal && pending.onAbort) pending.signal.removeEventListener('abort', pending.onAbort);
    if (error) pending.reject(error); else pending.resolve(value);
  }

  private onData(chunk: Buffer) {
    if (this.state !== 'running') return;
    let start = 0;
    for (;;) {
      const end = chunk.indexOf(0x0a, start);
      if (end === -1) break;
      if (this.bytes + (end - start) > MAX_LINE_BYTES) return this.kill(TOO_LARGE);
      this.chunks.push(chunk.subarray(start, end));
      const line = Buffer.concat(this.chunks).toString('utf8');
      this.chunks = []; this.bytes = 0;
      start = end + 1;
      this.onLine(line);
      if (this.state !== 'running') return;
    }
    if (start < chunk.length) {
      this.chunks.push(chunk.subarray(start));
      this.bytes += chunk.length - start;
      if (this.bytes > MAX_LINE_BYTES) this.kill(TOO_LARGE);
    }
  }

  private onLine(line: string) {
    let message: any;
    try { message = JSON.parse(line); } catch { return this.kill(`Bridge protocol violation: output was not a protocol message; ${UNCERTAIN}`); }
    if (!this.pending || message?.id !== this.pending.id) return this.kill(`Bridge protocol violation: unexpected reply; ${UNCERTAIN}`);
    if (typeof message.progress === 'string') return void this.pending.onProgress?.(message.progress);
    if (message.control === 'error' || message.ok === false) return this.settle(new Error(String(message.error ?? 'Bridge worker error')));
    this.settle(undefined, 'result' in message ? message.result : message.control);
  }
}

export class BridgeSession {
  readonly command: Command;
  private readonly healthMs: number;
  private readonly helloMs: number;
  private readonly closeGraceMs: number;
  private readonly deadlineMs?: number;
  private workers = new Map<string, Worker>();
  private queue: Promise<unknown> = Promise.resolve();
  // external: Upstream daemon event buffers are emptied by reads.
  /** Upstream daemons keep one event buffer each, and reading it empties it. Sessions sharing a daemon would steal each other's network and dialog events, so each session names its own. */
  readonly daemon = 'pi-' + randomBytes(4).toString('hex');

  constructor(options: Options = {}) {
    this.command = options.command ?? DEFAULT_COMMAND;
    this.healthMs = options.healthMs ?? 2000;
    this.helloMs = options.helloMs ?? 15000;
    this.closeGraceMs = options.closeGraceMs ?? 3000;
    this.deadlineMs = options.deadlineMs;
  }

  get liveWorkers(): number {
    return [...this.workers.values()].filter(worker => worker.alive).length;
  }


  /** Actions of one session run one at a time, in order. */
  send(request: Request, signal?: AbortSignal, onProgress?: (text: string) => void): Promise<any> {
    const run = this.queue.then(() => this.dispatch(request, signal, onProgress));
    this.queue = run.catch(() => undefined);
    return run;
  }


  /** Ends every worker of this session (EOF). Tabs stay open: only the bridge is released. Later actions start fresh workers. */
  async close(): Promise<{ ended: number; killed: number }> {
    const workers = [...this.workers.values()].filter(worker => worker.alive);
    this.workers.clear();
    const outcomes = await Promise.all(workers.map(worker => worker.end(this.closeGraceMs)));
    return { ended: outcomes.filter(outcome => outcome === 'ended').length, killed: outcomes.filter(outcome => outcome === 'killed').length };
  }

  private async dispatch(request: Request, signal?: AbortSignal, onProgress?: (text: string) => void): Promise<any> {
    if (signal?.aborted) throw new Error('Aborted before dispatch');
    const worker = await this.workerFor(String(request.endpoint));
    if (signal?.aborted) throw new Error('Aborted before dispatch');
    return worker.request(request, this.deadlineMs ?? bridgeDeadline(request), signal, onProgress);
  }

  private async workerFor(endpoint: string): Promise<Worker> {
    const current = this.workers.get(endpoint);
    if (current?.alive && await this.healthy(current)) return current;
    // external: Replacing a worker before sending the next action cannot replay that action.
    current?.kill('Bridge worker unresponsive before dispatch; restarted.');
    const fresh = await Worker.start(this.command, endpoint, this.helloMs, this.daemon);
    this.workers.set(endpoint, fresh);
    return fresh;
  }

  private async healthy(worker: Worker): Promise<boolean> {
    try {
      await worker.request({ control: 'ping' }, this.healthMs);
      return true;
    } catch {
      return false;
    }
  }
}
