# Database Migration Safety Guidelines

## Backward-Compatibility Rules

1. **Never drop columns or tables in production** without first verifying no code references them.
2. **Rename via copy** — add the new column, backfill data, update code, then drop old column in a separate migration.
3. **Add columns as nullable** (or with a default) so the old code continues to work during deployment.
4. **Avoid changing column types** directly — create a new column, migrate data, then swap.

## PR Review Checklist

- [ ] Does the migration add new columns? If so, are they nullable or have defaults?
- [ ] Does the migration drop anything? If so, has all referencing code been removed first?
- [ ] Does the migration rename anything? If so, is it done via the copy strategy?
- [ ] Has the migration been tested against a copy of production data?
- [ ] Is the migration reversible? Is there a rollback plan?

## Destructive Migration Policy

Destructive migrations (column drops, table deletes, type changes) require:
1. Approval from at least one senior engineer
2. A tested rollback script
3. Execution during a maintenance window

## Rollback Procedures

1. Keep the previous migration state documented.
2. Use `prisma migrate resolve` for marking migrations as rolled back.
3. Always have a SQL rollback script ready before applying destructive changes.
