// Stand-in for a launched browser: a process that starts one child of its own, then both stay idle.
// Once both run, it writes "parent <pid>" and "child <pid>" to the file named by its first argument.
//
// The child has to outlive a parent-only kill, as a browser's helper processes do. On Windows libuv ends a
// non-detached child together with its parent (kill-on-close job), so the child is detached there; on POSIX it stays
// in the parent's process group, which is what the launcher's group kill reaches.
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const [file, role] = process.argv.slice(2);
if (role !== 'child') {
  const child = spawn(process.execPath, [process.argv[1], file, 'child'], { detached: process.platform === 'win32', stdio: 'ignore', windowsHide: true });
  writeFileSync(file, `parent ${process.pid}\nchild ${child.pid}\n`);
}
// A test run that is killed before its cleanup must not leave these behind for good.
setTimeout(() => process.exit(0), 60_000);
