// Exits with the code in argv[2] after the delay in argv[3], so a death can be arranged on purpose.
const code = Number(process.argv[2] ?? 0);
const delayMs = Number(process.argv[3] ?? 0);
setTimeout(() => process.exit(code), delayMs);
