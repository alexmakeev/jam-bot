import { readJson } from './storage.js';
import { run } from './coordinator.js';
import type { Config } from './model.js';
const [configFile, id] = process.argv.slice(2);
if (!configFile || !id) throw new Error('Usage: node dist/src/cli.js CONFIG.json CARD_ID');
try { console.log(JSON.stringify(await run(await readJson<Config>(configFile), id))); }
catch (error) { console.error(String(error)); process.exitCode = 1; }
