/** Test-only preload: observe real pooled and transaction SQL without replacing pg. */
import { appendFileSync } from 'node:fs';
import pg from 'pg';

const query = pg.Client.prototype.query;
pg.Client.prototype.query = function (...args) {
  const sql = typeof args[0] === 'string' ? args[0] : args[0].text;
  appendFileSync(process.env.TWO_RESTORE_SQL_TRACE, JSON.stringify(sql) + '\n');
  return query.apply(this, args);
};
