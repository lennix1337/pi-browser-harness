// Stand-in for a browser that becomes ready: it listens on a loopback port of the system's choice, announces it in
// DevToolsActivePort inside the profile folder (first argument) and answers /json/version with the same identity.
import { writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';

const identity = '/devtools/browser/stand-in';
const server = createServer((_request, response) => {
  response.setHeader('Content-Type', 'application/json');
  response.end(JSON.stringify({ webSocketDebuggerUrl: `ws://127.0.0.1:${server.address().port}${identity}` }));
});
server.listen(0, '127.0.0.1', () => writeFileSync(join(process.argv[2], 'DevToolsActivePort'), `${server.address().port}\n${identity}\n`));
// A test run that is killed before its cleanup must not leave this behind for good.
setTimeout(() => process.exit(0), 60_000);
