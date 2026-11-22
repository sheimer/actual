import { validate as isUuid } from 'uuid';

import { getAccountDb } from '#account-db';

export function createEnableBankingImportDevicesTable() {
  getAccountDb().exec(`
    CREATE TABLE enable_banking_import_devices (
      account_id TEXT PRIMARY KEY NOT NULL,
      device_id TEXT NOT NULL
    );
  `);
}

export function enableBankingImportDeviceError(
  accountId: string,
  deviceId: unknown,
  claim = false,
) {
  if (typeof deviceId !== 'string' || !isUuid(deviceId)) {
    return 'ENABLE_BANKING_IMPORT_DEVICE_REQUIRED';
  }
  const db = getAccountDb();
  if (claim) {
    // A competing claim must not replace the device that won the insert.
    db.mutate(
      'INSERT OR IGNORE INTO enable_banking_import_devices (account_id, device_id) VALUES (?, ?)',
      [accountId, deviceId],
    );
  }
  const owner = db.first(
    'SELECT device_id FROM enable_banking_import_devices WHERE account_id = ?',
    [accountId],
  );
  if (!owner) return 'ENABLE_BANKING_IMPORT_DEVICE_REQUIRED';
  return owner.device_id === deviceId
    ? null
    : 'ENABLE_BANKING_IMPORT_DEVICE_MISMATCH';
}
