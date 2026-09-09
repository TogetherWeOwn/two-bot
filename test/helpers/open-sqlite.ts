import { openSqlite } from '../../src/store/sqliteDriver.ts';

const db = await openSqlite(process.argv[2]!);
await db.close();
