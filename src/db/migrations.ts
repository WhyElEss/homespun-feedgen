import { Kysely, Migration, MigrationProvider, sql } from 'kysely'

const migrations: Record<string, Migration> = {}

// Before multi-feed support this service ran a single feed named by
// FEEDGEN_SHORTNAME, and every existing row belongs to it. Migration 002
// stamps those rows with that name. Keep FEEDGEN_SHORTNAME set to its old
// value while upgrading, or the rows are filed under a feed nobody serves.
const LEGACY_FEED_KEY = process.env.FEEDGEN_SHORTNAME ?? 'my-feed'

export const migrationProvider: MigrationProvider = {
  async getMigrations() {
    return migrations
  },
}

migrations['001'] = {
  async up(db: Kysely<unknown>) {
    await db.schema
      .createTable('post')
      .addColumn('uri', 'varchar', (col) => col.primaryKey())
      .addColumn('cid', 'varchar', (col) => col.notNull())
      .addColumn('indexedAt', 'varchar', (col) => col.notNull())
      .execute()
    await db.schema
      .createTable('sub_state')
      .addColumn('service', 'varchar', (col) => col.primaryKey())
      .addColumn('cursor', 'integer', (col) => col.notNull())
      .execute()
  },
  async down(db: Kysely<unknown>) {
    await db.schema.dropTable('post').execute()
    await db.schema.dropTable('sub_state').execute()
  },
}

// Multi-feed: one instance now serves several feeds off one Jetstream
// connection. `post` gains a `feed` column and the primary key becomes
// (feed, uri), so the same post can sit in more than one feed.
//
// SQLite cannot add a column to a primary key in place, so the table is
// rebuilt. Existing rows are assigned to LEGACY_FEED_KEY.
migrations['002'] = {
  async up(db: Kysely<unknown>) {
    await db.schema
      .createTable('post_new')
      .addColumn('uri', 'varchar', (col) => col.notNull())
      .addColumn('cid', 'varchar', (col) => col.notNull())
      .addColumn('indexedAt', 'varchar', (col) => col.notNull())
      .addColumn('feed', 'varchar', (col) => col.notNull())
      .addPrimaryKeyConstraint('post_pkey', ['feed', 'uri'])
      .execute()

    await sql`
      insert into post_new (uri, cid, "indexedAt", feed)
      select uri, cid, "indexedAt", ${LEGACY_FEED_KEY} from post
    `.execute(db)

    await db.schema.dropTable('post').execute()
    await db.schema.alterTable('post_new').renameTo('post').execute()

    // Serving a feed is: filter by feed, sort by recency. Pruning by count
    // walks the same index.
    await db.schema
      .createIndex('post_feed_indexedAt_idx')
      .on('post')
      .columns(['feed', 'indexedAt'])
      .execute()
  },
  async down(db: Kysely<unknown>) {
    // Collapse back to the single legacy feed. Rows belonging to any other
    // feed are dropped — they have no place in a single-feed schema.
    await db.schema.dropIndex('post_feed_indexedAt_idx').execute()
    await db.schema
      .createTable('post_old')
      .addColumn('uri', 'varchar', (col) => col.primaryKey())
      .addColumn('cid', 'varchar', (col) => col.notNull())
      .addColumn('indexedAt', 'varchar', (col) => col.notNull())
      .execute()
    await sql`
      insert into post_old (uri, cid, "indexedAt")
      select uri, cid, "indexedAt" from post where feed = ${LEGACY_FEED_KEY}
    `.execute(db)
    await db.schema.dropTable('post').execute()
    await db.schema.alterTable('post_old').renameTo('post').execute()
  },
}

// Labels that Bluesky's moderation service has put on stored posts. They are
// not in the record, so the firehose never carries them: src/labels.ts follows
// the labeler's own stream and asks it about each new post once, and a feed
// then declines to SERVE a post carrying a label it names. Nothing is deleted
// on account of a label — a label withdrawn on appeal brings the post back.
//
// label_check is which stored posts have been asked about. label_state holds
// the stream's cursor; it is deliberately not sub_state, whose every row the
// status page and the parity check read as a Jetstream time_us.
migrations['003'] = {
  async up(db: Kysely<unknown>) {
    await db.schema
      .createTable('post_label')
      .addColumn('uri', 'varchar', (col) => col.notNull())
      .addColumn('val', 'varchar', (col) => col.notNull())
      .addColumn('cts', 'varchar', (col) => col.notNull())
      .addColumn('exp', 'varchar')
      .addPrimaryKeyConstraint('post_label_pkey', ['uri', 'val'])
      .execute()
    await db.schema
      .createTable('label_check')
      .addColumn('uri', 'varchar', (col) => col.primaryKey())
      .addColumn('checkedAt', 'varchar', (col) => col.notNull())
      .execute()
    await db.schema
      .createTable('label_state')
      .addColumn('service', 'varchar', (col) => col.primaryKey())
      .addColumn('cursor', 'integer', (col) => col.notNull())
      .execute()
    // Every label on the stream is looked up by post URI alone, about once a
    // second, and the primary key leads with the feed.
    await db.schema.createIndex('post_uri_idx').on('post').column('uri').execute()
  },
  async down(db: Kysely<unknown>) {
    await db.schema.dropIndex('post_uri_idx').execute()
    await db.schema.dropTable('label_state').execute()
    await db.schema.dropTable('label_check').execute()
    await db.schema.dropTable('post_label').execute()
  },
}
