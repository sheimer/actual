import { getAccountDb } from '../src/account-db';
import { createSharedImportTable } from '../src/app-enablebanking/shared-import';

export async function up() {
  createSharedImportTable();
}

export async function down() {
  getAccountDb().exec(`
    DROP TRIGGER clear_enable_banking_imports_on_file_change;
    DROP TABLE enable_banking_imports;
  `);
}
