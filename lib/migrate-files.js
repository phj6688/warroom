const { log } = require('./logger');

/**
 * Migrate legacy session_files rows (inline content) to files-service.
 * Idempotent: rows that succeed are deleted from session_files_legacy;
 * rows that fail stay for the next run.
 */
async function runLegacyFileMigration(db, filesServiceClient) {
  const hasLegacy = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='session_files_legacy'"
  ).get();

  if (!hasLegacy) {
    log.info('legacy file migration: no legacy table, nothing to do');
    return { total: 0, migrated: 0, failed: 0 };
  }

  // Verify files-service is reachable before touching data
  await filesServiceClient.health();

  const legacyRows = db.prepare(
    'SELECT rowid, id, session_id, name, size, type, content, created_at FROM session_files_legacy'
  ).all();

  const summary = { total: legacyRows.length, migrated: 0, failed: 0 };

  if (legacyRows.length === 0) {
    db.exec('DROP TABLE session_files_legacy');
    log.info('legacy file migration: legacy table empty, dropped');
    return summary;
  }

  log.info({ count: legacyRows.length }, 'legacy file migration: starting');

  const insertNew = db.prepare(`
    INSERT OR IGNORE INTO session_files
      (session_id, file_id, file_sha256, file_name, file_tokens, file_mime, attached_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const deleteLegacy = db.prepare('DELETE FROM session_files_legacy WHERE rowid = ?');

  for (const row of legacyRows) {
    try {
      const buf = row.content
        ? (Buffer.isBuffer(row.content) ? row.content : Buffer.from(row.content))
        : Buffer.alloc(0);

      const result = await filesServiceClient.uploadFiles([{
        buffer: buf,
        name: row.name || 'unnamed',
        mime: row.type || 'application/octet-stream',
      }]);

      const file = result.files[0];
      insertNew.run(
        row.session_id,
        file.id,
        file.sha256,
        file.name,
        file.tokens,
        file.mime,
        row.created_at
      );
      deleteLegacy.run(row.rowid);
      summary.migrated++;
    } catch (err) {
      log.warn({ err: err.message, rowid: row.rowid, name: row.name }, 'legacy file migration: row failed');
      summary.failed++;
    }
  }

  // Drop legacy table if fully migrated
  const remaining = db.prepare('SELECT COUNT(*) as n FROM session_files_legacy').get().n;
  if (remaining === 0) {
    db.exec('DROP TABLE session_files_legacy');
    log.info('legacy file migration: legacy table dropped');
  }

  log.info({ summary }, 'legacy file migration: complete');
  return summary;
}

module.exports = { runLegacyFileMigration };
