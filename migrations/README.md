# Migrations

Plain `.sql` files, applied in filename order, each inside one transaction,
each recorded in `schema_migrations`. Applied by `npm run migrate` and
automatically at bot startup.

Postgres only. The SQLite path still bootstraps from `src/store/schema.sql`;
it is being deleted (TWO-18) and is not worth a second dialect.

## Rules

1. **Never edit a migration that has been applied anywhere.** Add a new one.
   The runner records a checksum and will refuse to start if a file it has
   already applied has changed underneath it.
2. **Additive by default.** A migration has to be safe to run while the old
   code is still up, because during a deploy it is.
3. One logical change per file.

## Number ranges — two teams share this directory

| Range       | Owner                     |
| ----------- | ------------------------- |
| `0001–0999` | Bot (Founding Engineer)   |
| `1000–1999` | Website (Laravel team)    |

Pick the next free number **in your own range** so we do not collide in a
merge. Filename: `NNNN_short_snake_case.sql`.

> Laravel's own migrator is not pointed at these tables. The website reads the
> bot's tables through the read-only contract (TWO-23); if it needs schema of
> its own it adds it here in the 1000 range, or in its own schema. Two
> migration tools writing the same `schema_migrations` table would be a bad
> time.
