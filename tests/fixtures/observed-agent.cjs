// Synthetic stdio source. It has no provider authentication, model calls, or file access.
const readline = require('node:readline');
readline.createInterface({ input: process.stdin }).on('line', line => {
  const packet = JSON.parse(line);
  for (const event of packet.events ?? []) process.stdout.write(JSON.stringify(event) + '\n');
  if (packet.raw) process.stdout.write(packet.raw);
  if (packet.exit) process.stdout.end(() => process.exit(0));
});
