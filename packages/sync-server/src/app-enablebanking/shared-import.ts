import { v4 as uuidv4 } from 'uuid';

import { getAccountDb } from '#account-db';
import { canAccessActiveFile } from '#services/user-service';

export function createSharedImportTable() {
  getAccountDb().exec(`
    CREATE TABLE enable_banking_imports (
      file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
      group_id TEXT NOT NULL,
      account_id TEXT NOT NULL,
      connection_id TEXT NOT NULL,
      id TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('open', 'accepted', 'completed')),
      download TEXT,
      plan TEXT,
      PRIMARY KEY (file_id, group_id, account_id, connection_id)
    );
    CREATE TRIGGER clear_enable_banking_imports_on_file_change
    AFTER UPDATE OF group_id, deleted ON files
    WHEN OLD.group_id IS NOT NEW.group_id OR NEW.deleted = 1
    BEGIN
      DELETE FROM enable_banking_imports WHERE file_id = NEW.id;
    END;
  `);
}

type Scope = {
  fileId: string;
  groupId: string;
  accountId: string;
  connectionId: string;
};

type Batch = {
  id: string;
  state: 'open' | 'accepted' | 'completed';
  download: string | null;
  plan: string | null;
};

const scopeQuery =
  'file_id = ? AND group_id = ? AND account_id = ? AND connection_id = ?';

function scopeValues(scope: Scope) {
  return [scope.fileId, scope.groupId, scope.accountId, scope.connectionId];
}

function validId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 255;
}

function isCurrentGroup(scope: Scope) {
  return !!getAccountDb().first(
    'SELECT id FROM files WHERE id = ? AND group_id = ? AND deleted = 0',
    [scope.fileId, scope.groupId],
  );
}

export function getImportScope(body: unknown, userId: string): Scope | null {
  if (!body || typeof body !== 'object') return null;
  const { fileId, groupId, accountId, connectionId } = body as Partial<Scope>;
  if (
    !validId(fileId) ||
    !validId(groupId) ||
    !validId(accountId) ||
    !validId(connectionId) ||
    !canAccessActiveFile(fileId, userId)
  ) {
    return null;
  }
  const scope = { fileId, groupId, accountId, connectionId };
  return isCurrentGroup(scope) ? scope : null;
}

export function readImport(scope: Scope) {
  const row = getAccountDb().first(
    `SELECT id, state, download, plan FROM enable_banking_imports WHERE ${scopeQuery}`,
    scopeValues(scope),
  ) as Batch | undefined;
  return row
    ? {
        id: row.id,
        state: row.state,
        download: row.download ? JSON.parse(row.download) : null,
        plan: row.plan,
      }
    : null;
}

const downloads = new Map<string, Promise<unknown>>();

export async function downloadImport(
  scope: Scope,
  after: unknown,
  fetchDownload: () => Promise<{ download: unknown } | { error_code: string }>,
) {
  const current = readImport(scope);
  if (current && (current.state !== 'completed' || current.id !== after)) {
    return current;
  }

  const key = JSON.stringify(scopeValues(scope));
  let download = downloads.get(key);
  if (!download) {
    download = (async () => {
      const result = await fetchDownload();
      if ('error_code' in result) return result;
      if (!isCurrentGroup(scope)) return null;
      getAccountDb().mutate(
        `INSERT INTO enable_banking_imports
          (file_id, group_id, account_id, connection_id, id, state, download)
         VALUES (?, ?, ?, ?, ?, 'open', ?)
         ON CONFLICT (file_id, group_id, account_id, connection_id)
         DO UPDATE SET id = excluded.id, state = 'open', download = excluded.download
         WHERE enable_banking_imports.state = 'completed' AND enable_banking_imports.id = ?`,
        [
          ...scopeValues(scope),
          uuidv4(),
          JSON.stringify(result.download),
          after ?? null,
        ],
      );
      return readImport(scope);
    })().finally(() => {
      downloads.delete(key);
    });
    downloads.set(key, download);
  }
  return download;
}

export function confirmImport(scope: Scope, id: string, plan: string) {
  const db = getAccountDb();
  const result = db.mutate(
    `UPDATE enable_banking_imports SET state = 'accepted', download = NULL, plan = ?
     WHERE ${scopeQuery} AND id = ? AND state = 'open'`,
    [plan, ...scopeValues(scope), id],
  );
  return { won: result.changes === 1, batch: readImport(scope) };
}

export function completeImport(scope: Scope, id: string) {
  getAccountDb().mutate(
    `UPDATE enable_banking_imports SET state = 'completed', plan = NULL
     WHERE ${scopeQuery} AND id = ? AND state = 'accepted'`,
    [...scopeValues(scope), id],
  );
  return readImport(scope);
}
