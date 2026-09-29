// Writes the number of bytes in argv[2] to stdout and again to stderr, then exits 0 once both are written.
const bytes = Buffer.alloc(Number(process.argv[2] ?? 0), 'x');
process.stdout.write(bytes);
process.stderr.write(bytes);
