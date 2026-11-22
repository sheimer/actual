import { getAccountDb } from '../src/account-db';
import { createEnableBankingImportDevicesTable } from '../src/app-enablebanking/import-device';

export async function up() {
  createEnableBankingImportDevicesTable();
}

export async function down() {
  getAccountDb().exec('DROP TABLE enable_banking_import_devices');
}
