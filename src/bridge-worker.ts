import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { bridgeDeadline, python, root, type Request } from './client.ts';

/**
 * Persistent bridge: one Python worker per endpoint, reused by every action of a Pi session, instead of one process
 * per action. The worker speaks JSON lines (`python/bridge.py --serve`): a hello with the endpoint, then requests and
 * pings, each answered with the same `id`.
 *
 * Safety rules, unchanged from the one-shot bridge:
 * - an action is sent to a worker only after that worker answered a ping, so a dead or unresponsive worker is replaced
 *   before anything is dispatched and nothing is replayed;
 * - a crash, deadline, abort, oversized or non-protocol reply during an action kills that worker and reports the
 *   action as uncertain; the next action starts a fresh worker;
 * - closing a session sends EOF: the worker exits by itself; a worker that ignores EOF is killed after a grace period.
 */
export type Command = { python: string; args: string[] };
export type Options = { command?: Command; healthMs?: number; helloMs?: number; closeGraceMs?: number; deadlineMs?: number };

const MAX_LINE_BYTES = 8 * 1024 * 1024;
const DEFAULT_COMMAND: Command = { python, args: [join(root, 'python/bridge.py'), '--serve'] };
const EXTERNAL = 'external outcome uncertain. Inspect before retrying.';
const UNCERTAIN = 'outcome uncertain. Inspect before retrying.';
const TOO_LARGE = 'Response exceeds 8 MiB; outcome uncertain. Narrow the query before continuing.';

type Pending = { id: number; resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout; signal?: AbortSignal; onAbort?: () => void };
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
    // Python diagnostics can contain page content: they are drained, never kept or surfaced.
    child.stderr.resume();
    child.stdin.on('error', () => this.kill(`Bridge input delivery failed; ${EXTERNAL}`));
    child.once('error', error => this.kill(`Bridge worker failed: ${error.message}; ${UNCERTAIN}`));
    // 'close' (not 'exit') fires after stdout is drained, so a reply written just before exit is still read.
    child.once('close', code => {
      this.exitCode = code;
      if (this.state === 'running') this.state = 'exited';
      this.settle(new Error(`Bridge worker exited during the request; ${UNCERTAIN}`));
      this.resolveClosed();
    });
    // An idle worker must not keep the Pi process alive (EOF ends it). The stdio pipes are sockets that stay ref'd
    // on their own, so each one is unref'd too; the stream types do not declare unref, hence the cast. A request in
    // flight keeps its own deadline timer ref'd.
    child.unref();
    for (const stream of [child.stdin, child.stdout, child.stderr]) (stream as unknown as { unref?: () => void }).unref?.();
  }

  get alive() { return this.state === 'running'; }

  static async start(command: Command, endpoint: string, helloMs: number): Promise<Worker> {
    if (!existsSync(command.python)) throw new Error(`Runtime missing. Run npm run setup in ${root}`);
    const child = spawn(command.python, command.args, {
      cwd: root, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
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

  /** One request in flight at a time. Resolves with the reply's `result`; rejects with the bridge's error. */
  request(payload: Record<string, unknown>, deadlineMs: number, signal?: AbortSignal): Promise<any> {
    if (signal?.aborted) return Promise.reject(new Error('Aborted before dispatch'));
    if (!this.alive) return Promise.reject(new Error(`Bridge worker is not running; ${UNCERTAIN}`));
    if (this.pending) return Promise.reject(new Error('Bridge worker busy; serialize interactions.'));
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const pending: Pending = { id, resolve, reject, signal, timer: setTimeout(() => this.kill(`Deadline exceeded; ${EXTERNAL}`), deadlineMs) };
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

  /** Ends the worker with EOF. Resolves 'ended' when it exits on its own with status 0, 'killed' otherwise. */
  async end(graceMs: number): Promise<'ended' | 'killed'> {
    if (!this.alive) return 'killed';
    this.child.stdin.end();
    const timer = setTimeout(() => this.kill(`Bridge worker did not exit after close; ${UNCERTAIN}`), graceMs);
    await this.closed;
    clearTimeout(timer);
    return this.state === 'exited' && this.exitCode === 0 ? 'ended' : 'killed';
  }

  /** Stops the worker. Whatever was in flight settles with the reason as its error. */
  kill(reason: string) {
    if (this.state !== 'running') return;
    this.state = 'killed';
    this.child.stdin.destroy();
    this.child.kill();
    // A process that never spawned emits no 'close': nothing would ever resolve the close wait.
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
  send(request: Request, signal?: AbortSignal): Promise<any> {
    const run = this.queue.then(() => this.dispatch(request, signal));
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

  private async dispatch(request: Request, signal?: AbortSignal): Promise<any> {
    if (signal?.aborted) throw new Error('Aborted before dispatch');
    const worker = await this.workerFor(String(request.endpoint));
    if (signal?.aborted) throw new Error('Aborted before dispatch');
    return worker.request(request, this.deadlineMs ?? bridgeDeadline(request.action), signal);
  }

  private async workerFor(endpoint: string): Promise<Worker> {
    const current = this.workers.get(endpoint);
    if (current?.alive && await this.healthy(current)) return current;
    // Nothing of the next action has been sent yet, so replacing a dead or unresponsive worker replays nothing.
    current?.kill('Bridge worker unresponsive before dispatch; restarted.');
    const fresh = await Worker.start(this.command, endpoint, this.helloMs);
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
