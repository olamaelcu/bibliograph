import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { createApp } from './app.js';
import { db } from './db/connection.js';
import { setupFts, setupIdentifiersView, bootstrapLibrarian, bootstrapFeatures, bootstrapContributorTypes } from './db/init.js';

migrate(db, { migrationsFolder: './drizzle' });
setupFts();
setupIdentifiersView();
bootstrapLibrarian();
bootstrapFeatures();
await bootstrapContributorTypes();

export default createApp();
