import path from "path";
import { pathToFileURL } from "url";

// `runDev.js --light`: every worker script given on the command line, in this one process.
for (const script of process.argv.slice(2)) await import(pathToFileURL(path.resolve(script)).href);
