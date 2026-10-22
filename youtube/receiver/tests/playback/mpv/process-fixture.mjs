import { createServer } from 'node:net';

const socketPath = process.argv.find(arg => arg.startsWith('--input-ipc-server=')).split('=')[1];
let loaded;
let action = 'load';
const server = createServer(socket => {
  socket.setEncoding('utf8');
  let buffer = '';
  socket.on('data', chunk => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const { command, request_id } = JSON.parse(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
      if (command[0] === 'quit') process.exit(0);
      if (command[0] === 'set_property' && command[1] === 'fixture-action') action = command[2];
      if (command[0] === 'loadfile') loaded = command;
      socket.write(`${JSON.stringify({ request_id, error: 'success', data: loaded })}\n`);
      if (command[0] !== 'loadfile' || action === 'hold') continue;
      if (action === 'disconnect') { socket.destroy(); continue; }
      const event = action === 'error' ? { event: 'end-file', reason: 'error' } : { event: 'file-loaded' };
      socket.write(`${JSON.stringify(event)}\n`);
    }
  });
});
server.listen(socketPath);
