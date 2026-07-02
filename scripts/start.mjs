// Production start wrapper. The standalone Astro server loads route/middleware
// modules lazily — on a zero-traffic deploy the reminder loop (booted from
// middleware module scope) would never start. Importing the entry starts the
// HTTP server; one loopback poke then forces the middleware module graph to
// load so boot-time singletons run without waiting for real traffic.
// The poke is scheduled BEFORE the import: the entry keeps the process alive
// and its module promise may never settle.
const port = process.env.PORT ?? "4322";
// Without HOST the adapter binds "localhost" (::1 on some systems); with
// HOST=0.0.0.0 (Railway) 127.0.0.1 works. Try both.
setTimeout(async () => {
  for (const host of ["127.0.0.1", "localhost"]) {
    try {
      await fetch(`http://${host}:${port}/login`);
      return;
    } catch {
      // try the next host
    }
  }
  console.warn("[start] boot poke failed (reminder loop starts on first real request)");
}, 3000);

await import("../dist/server/entry.mjs");
