#!/usr/bin/env node
// Release task for Dokku deployments.
// SQLite schema is initialized at web process startup (CREATE TABLE IF NOT EXISTS).
// No persistent database connection is available in the ephemeral release container.
// If you switch to PostgreSQL, move the migration runner here.

const dbPath = process.env.DB_PATH || 'data/bibliograph.db';
console.log(`Release phase: database schema will be initialized at web startup (${dbPath})`);
console.log('Release complete.');
