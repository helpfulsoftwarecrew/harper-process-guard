// A process that stays up until something stops it. It must NOT set process.title: the command line
// is how these are told apart and counted, and rewriting argv erases the only identity there is.
setInterval(() => {}, 1 << 30);
