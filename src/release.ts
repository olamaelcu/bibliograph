#!/usr/bin/env node
import { runMigrations } from './db/init.js';

console.log('Running release migrations...');
await runMigrations();
console.log('Migrations complete.');
process.exit(0);
