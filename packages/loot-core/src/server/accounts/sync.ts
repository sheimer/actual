// @ts-strict-ignore
import * as dateFns from 'date-fns';
import { v4 as uuidv4 } from 'uuid';

import * as asyncStorage from '#platform/server/asyncStorage';
import * as fs from '#platform/server/fs';
import { logger } from '#platform/server/log';
import { aqlQuery } from '#server/aql';
import * as db from '#server/db';
import { TRANSACTION_SORT_INCREMENT } from '#server/db/sort';
import { decrypt, encrypt } from '#server/encryption';
import { TransactionError } from '#server/errors';
import { runMutator } from '#server/mutators';
import { post } from '#server/post';
import { getPrefs } from '#server/prefs';
import { getServer } from '#server/server-config';
import { batchMessages, checkSyncingMode, fullSync } from '#server/sync';
import { batchUpdateTransactions } from '#server/transactions';
import { runRules } from '#server/transactions/transaction-rules';
import {
  defaultMappings,
  mappingsFromString,
} from '#server/util/custom-sync-mapping';
import { sequential } from '#shared/async';
import * as monthUtils from '#shared/months';
import { q } from '#shared/query';
import {
  makeChild as makeChildTransaction,
  recalculateSplit,
} from '#shared/transactions';
import {
  amountToInteger,
  hasFieldsChanged,
  integerToAmount,
} from '#shared/util';
import type {
  AccountEntity,
  BankSyncResponse,
  TransactionEntity,
} from '#types/models';

import {
  EnableBankingReviewRequired,
  planEnableBankingMatches,
} from './enable-banking-match';
import type {
  Choice,
  EnableBankingMatching,
  EnableBankingPayment,
  Review,
} from './enable-banking-match';
import { getStartingBalanceCategory, getStartingBalancePayee } from './payees';
import { title } from './title';

function BankSyncError(type: string, code: string, details?: object) {
  return { type: 'BankSyncError', category: type, code, details };
}

function makeSplitTransaction(trans, subtransactions) {
  // We need to calculate the final state of split transactions
  const { subtransactions: sub, ...parent } = recalculateSplit({
    ...trans,
    is_parent: true,
    subtransactions: subtransactions.map((transaction, idx) =>
      makeChildTransaction(trans, {
        ...transaction,
        sort_order: 0 - idx,
      }),
    ),
  });
  return [parent, ...sub];
}

function getAccountBalance(account) {
  // Debt account types need their balance reversed
  switch (account.type) {
    case 'credit':
    case 'loan':
      return -account.balances.current;
    default:
      return account.balances.current;
  }
}

async function updateAccountBalance(id: AccountEntity['id'], balance: number) {
  await db.update('accounts', { id, balance_current: balance });
}

async function getAccountOldestTransaction(id): Promise<TransactionEntity> {
  return (
    await aqlQuery(
      q('transactions')
        .filter({
          account: id,
          date: { $lte: monthUtils.currentDay() },
        })
        .select('date')
        .orderBy('date')
        .limit(1),
    )
  ).data?.[0];
}

async function getAccountSyncStartDate(id) {
  // Many GoCardless integrations do not support getting more than 90 days
  // worth of data, so make that the earliest possible limit.
  // 89 days ago until today inclusive is 90 days.
  const dates = [monthUtils.subDays(monthUtils.currentDay(), 89)];

  const oldestTransaction = await getAccountOldestTransaction(id);

  if (oldestTransaction) dates.push(oldestTransaction.date);

  return monthUtils.dayFromDate(
    dateFns.max(dates.map(d => monthUtils.parseDate(d))),
  );
}

export async function getGoCardlessAccounts(userId, userKey, id) {
  const userToken = await asyncStorage.getItem('user-token');
  if (!userToken) return;

  const res = await post(
    getServer().GOCARDLESS_SERVER + '/accounts',
    {
      userId,
      key: userKey,
      item_id: id,
    },
    {
      'X-ACTUAL-TOKEN': userToken,
    },
  );

  const { accounts } = res;

  accounts.forEach(acct => {
    acct.balances.current = getAccountBalance(acct);
  });

  return accounts;
}

async function downloadGoCardlessTransactions(
  userId,
  userKey,
  acctId,
  bankId,
  since,
  includeBalance = true,
) {
  const userToken = await asyncStorage.getItem('user-token');
  if (!userToken) return;

  logger.log('Pulling transactions from GoCardless');

  const res = await post(
    getServer().GOCARDLESS_SERVER + '/transactions',
    {
      userId,
      key: userKey,
      requisitionId: bankId,
      accountId: acctId,
      startDate: since,
      includeBalance,
    },
    {
      'X-ACTUAL-TOKEN': userToken,
    },
  );

  if (res.error_code) {
    const errorDetails = {
      rateLimitHeaders: res.rateLimitHeaders,
    };

    throw BankSyncError(res.error_type, res.error_code, errorDetails);
  }

  if (includeBalance) {
    const {
      transactions: { all },
      balances,
      startingBalance,
    } = res;

    logger.log('Response:', res);

    return {
      transactions: all,
      accountBalance: balances,
      startingBalance,
    };
  } else {
    logger.log('Response:', res);

    return {
      transactions: res.transactions.all,
    };
  }
}

async function downloadSimpleFinTransactions(
  acctId: AccountEntity['id'] | AccountEntity['id'][],
  since: string | string[],
  fileId?: string,
) {
  const userToken = await asyncStorage.getItem('user-token');
  if (!userToken) return;

  const batchSync = Array.isArray(acctId);

  logger.log('Pulling transactions from SimpleFin');

  let res;
  try {
    res = await post(
      getServer().SIMPLEFIN_SERVER + '/transactions',
      {
        accountId: acctId,
        startDate: since,
      },
      {
        'X-ACTUAL-TOKEN': userToken,
        ...(fileId ? { 'X-Actual-File-Id': fileId } : {}),
      },
      // 5 minute timeout for batch sync, one minute for individual accounts
      Array.isArray(acctId) ? 300000 : 60000,
    );
  } catch (error) {
    logger.error('Suspected timeout during bank sync:', error);
    throw BankSyncError('TIMED_OUT', 'TIMED_OUT');
  }

  if (Object.keys(res).length === 0) {
    throw BankSyncError('NO_DATA', 'NO_DATA');
  }
  if (res.error_code) {
    throw BankSyncError(res.error_type, res.error_code);
  }

  let retVal = {};
  if (batchSync) {
    const batchErrors = res.errors;
    for (const accountId of Object.keys(res)) {
      if (accountId === 'errors') continue;

      const data = res[accountId];
      const error = batchErrors?.[accountId]?.[0];

      retVal[accountId] = {
        transactions: data?.transactions?.all,
        accountBalance: data?.balances,
        startingBalance: data?.startingBalance,
      };

      if (error) {
        retVal[accountId].error_type = error.error_type;
        retVal[accountId].error_code = error.error_code;
      }
    }

    // Add entries for accounts that only have errors (no data in the response)
    if (batchErrors) {
      for (const [accountId, errorList] of Object.entries(batchErrors)) {
        if (
          !retVal[accountId] &&
          Array.isArray(errorList) &&
          errorList.length > 0
        ) {
          const error = errorList[0];
          retVal[accountId] = {
            transactions: [],
            accountBalance: [],
            startingBalance: 0,
            error_type: error.error_type,
            error_code: error.error_code,
          };
        }
      }
    }
  } else {
    retVal = {
      transactions: res.transactions.all,
      accountBalance: res.balances,
      startingBalance: res.startingBalance,
    };
  }

  logger.log('Response:', retVal);
  return retVal;
}

async function downloadPluggyAiTransactions(
  acctId: AccountEntity['id'],
  since: string,
  fileId?: string,
) {
  const userToken = await asyncStorage.getItem('user-token');
  if (!userToken) return;

  logger.log('Pulling transactions from Pluggy.ai');

  const res = await post(
    getServer().PLUGGYAI_SERVER + '/transactions',
    {
      accountId: acctId,
      startDate: since,
    },
    {
      'X-ACTUAL-TOKEN': userToken,
      ...(fileId ? { 'X-Actual-File-Id': fileId } : {}),
    },
    60000,
  );

  if (res.error_code) {
    throw BankSyncError(res.error_type, res.error_code);
  } else if ('error' in res) {
    throw BankSyncError('Connection', res.error);
  }

  let retVal = {};
  const singleRes = res as BankSyncResponse;
  retVal = {
    transactions: singleRes.transactions.all,
    accountBalance: singleRes.balances,
    startingBalance: singleRes.startingBalance,
  };

  logger.log('Response:', retVal);
  return retVal;
}

async function downloadAkahuTransactions(
  acctId: AccountEntity['id'],
  since: string,
) {
  const userToken = await asyncStorage.getItem('user-token');
  if (!userToken) return;

  logger.log('Pulling transactions from Akahu');

  const res = await post(
    getServer().AKAHU_SERVER + '/transactions',
    {
      accountId: acctId,
      startDate: since,
    },
    {
      'X-ACTUAL-TOKEN': userToken,
    },
    60000,
  );

  if (res.error_code) {
    throw BankSyncError(res.error_type, res.error_code);
  } else if ('error' in res) {
    throw BankSyncError('Connection', res.error);
  }

  let retVal = {};
  const singleRes = res as BankSyncResponse;
  retVal = {
    transactions: singleRes.transactions.all,
    accountBalance: singleRes.balances,
    startingBalance: singleRes.startingBalance,
  };

  logger.log('Response:', retVal);
  return retVal;
}

const getEnableBankingDeviceId = sequential(async () => {
  const existing = await asyncStorage.getItem('enable-banking-import-device');
  if (existing) return existing;
  const id = uuidv4();
  await asyncStorage.setItem('enable-banking-import-device', id);
  return id;
});

async function checkEnableBankingImportDevice(
  accountId: string,
  claim = false,
) {
  const server = getServer();
  const token = await asyncStorage.getItem('user-token');
  if (!server || !token) {
    throw BankSyncError(
      'ENABLE_BANKING_IMPORT_DEVICE_REQUIRED',
      'ENABLE_BANKING_IMPORT_DEVICE_REQUIRED',
    );
  }
  const response = await post(
    server.ENABLEBANKING_SERVER + '/import-device',
    { accountId, deviceId: await getEnableBankingDeviceId(), claim },
    { 'X-ACTUAL-TOKEN': token },
  );
  if (response.error_code) {
    throw BankSyncError(response.error_type, response.error_code);
  }
}

export async function claimEnableBankingImportDevice(id: string) {
  const account = await db.select('accounts', id);
  if (!isLinkedEnableBankingAccount(account)) {
    throw new Error('The bank account is no longer linked.');
  }
  if (!sharedImportScope(account)) {
    await checkEnableBankingImportDevice(account.account_id, true);
  }
  return 'ok';
}

async function downloadEnableBankingTransactions(
  acctId: string,
  since: string,
  aspspName?: string,
) {
  const userToken = await asyncStorage.getItem('user-token');
  if (!userToken) return;

  logger.log('Pulling transactions from Enable Banking');

  const res = await post(
    getServer().ENABLEBANKING_SERVER + '/transactions',
    {
      accountId: acctId,
      startDate: since,
      aspspName,
      deviceId: await getEnableBankingDeviceId(),
    },
    {
      'X-ACTUAL-TOKEN': userToken,
    },
    60000,
  );

  if (res.error_code) {
    throw BankSyncError(res.error_type, res.error_code);
  }

  const {
    transactions: { all },
    balances,
    startingBalance,
  } = res;

  return {
    transactions: all,
    accountBalance: balances,
    // A missing balance is different from a reported balance of zero.
    startingBalance: startingBalance ?? null,
  };
}

async function resolvePayee(trans, payeeName, payeesToCreate) {
  if (trans.payee == null && payeeName) {
    // First check our registry of new payees (to avoid a db access)
    // then check the db for existing payees
    let payee = payeesToCreate.get(payeeName.toLowerCase());
    payee = payee || (await db.getPayeeByName(payeeName));

    if (payee != null) {
      return payee.id;
    } else {
      // Otherwise we're going to create a new one
      const newPayee = { id: uuidv4(), name: payeeName };
      payeesToCreate.set(payeeName.toLowerCase(), newPayee);
      return newPayee.id;
    }
  }

  return trans.payee;
}

export const PAYEE_NAME_NORMALIZATIONS = ['original', 'title-case'] as const;
export type PayeeNameNormalization = (typeof PAYEE_NAME_NORMALIZATIONS)[number];

function normalizePayeeName(
  payeeName: string,
  normalization: PayeeNameNormalization,
): string {
  switch (normalization) {
    case 'original':
      return payeeName;
    case 'title-case':
      return title(payeeName);
    default:
      normalization satisfies never;
      throw new Error(
        `Unknown payee name normalization: ${String(normalization)}`,
      );
  }
}

async function normalizeTransactions(
  transactions,
  acctId,
  {
    payeeNameNormalization = 'title-case',
  }: {
    payeeNameNormalization?: PayeeNameNormalization;
  } = {},
) {
  const payeesToCreate = new Map();

  const normalized = [];
  for (let trans of transactions) {
    // Validate the date because we do some stuff with it. The db
    // layer does better validation, but this will give nicer errors
    if (trans.date == null) {
      throw new Error('`date` is required when adding a transaction');
    }

    // Strip off the irregular properties
    const { payee_name: originalPayeeName, subtransactions, ...rest } = trans;
    trans = rest;

    if (trans.amount != null && !Number.isInteger(trans.amount)) {
      throw new TransactionError(
        `Amount is invalid, must be an integer: ${trans.amount}`,
      );
    }

    if (subtransactions) {
      for (const sub of subtransactions) {
        if (sub.amount != null && !Number.isInteger(sub.amount)) {
          throw new TransactionError(
            `Subtransaction amount is invalid, must be an integer: ${sub.amount}`,
          );
        }
      }
    }

    let payee_name = originalPayeeName;
    if (payee_name) {
      const trimmed = payee_name.trim();
      if (trimmed === '') {
        payee_name = null;
      } else {
        payee_name = normalizePayeeName(trimmed, payeeNameNormalization);
      }
    }

    trans.imported_payee = trans.imported_payee || payee_name;
    if (trans.imported_payee) {
      trans.imported_payee = trans.imported_payee.trim();
    }

    // It's important to resolve both the account and payee early so
    // when rules are run, they have the right data. Resolving payees
    // also simplifies the payee creation process
    trans.account = acctId;
    trans.payee = await resolvePayee(trans, payee_name, payeesToCreate);

    trans.category = trans.category ?? null;

    normalized.push({
      payee_name,
      subtransactions: subtransactions
        ? subtransactions.map(t => ({ ...t, account: acctId }))
        : null,
      trans,
    });
  }

  return { normalized, payeesToCreate };
}

async function normalizeBankSyncTransactions(transactions, acctId) {
  const payeesToCreate = new Map();

  const [customMappingsRaw, importPending, importNotes] = await Promise.all([
    aqlQuery(
      q('preferences')
        .filter({ id: `custom-sync-mappings-${acctId}` })
        .select('value'),
    ).then(data => data?.data?.[0]?.value),
    aqlQuery(
      q('preferences')
        .filter({ id: `sync-import-pending-${acctId}` })
        .select('value'),
    ).then(data => String(data?.data?.[0]?.value ?? 'true') === 'true'),
    aqlQuery(
      q('preferences')
        .filter({ id: `sync-import-notes-${acctId}` })
        .select('value'),
    ).then(data => String(data?.data?.[0]?.value ?? 'true') === 'true'),
  ]);

  const mappings = customMappingsRaw
    ? mappingsFromString(customMappingsRaw)
    : defaultMappings;

  const categoryIds = new Set((await db.getCategories()).map(c => c.id));
  const normalized = [];
  for (const trans of transactions) {
    trans.cleared = Boolean(trans.booked);

    if (!importPending && !trans.cleared) continue;

    if (!trans.amount) {
      trans.amount = trans.transactionAmount.amount;
    }

    const mapping = mappings.get(trans.amount <= 0 ? 'payment' : 'deposit');

    const date = trans[mapping.get('date')] ?? trans.date;
    const payeeName = trans[mapping.get('payee')] ?? trans.payeeName;
    const notes = trans[mapping.get('notes')];

    // Validate the date because we do some stuff with it. The db
    // layer does better validation, but this will give nicer errors
    if (date == null) {
      throw new Error('`date` is required when adding a transaction');
    }

    if (payeeName == null) {
      throw new Error('`payeeName` is required when adding a transaction');
    }

    trans.imported_payee = trans.imported_payee || payeeName;
    if (trans.imported_payee) {
      trans.imported_payee = trans.imported_payee.trim();
    }

    let imported_id = trans.transactionId;
    if (trans.cleared && !trans.transactionId && trans.internalTransactionId) {
      imported_id = `${trans.account}-${trans.internalTransactionId}`;
    }

    // It's important to resolve both the account and payee early so
    // when rules are run, they have the right data. Resolving payees
    // also simplifies the payee creation process
    trans.account = acctId;
    trans.payee = await resolvePayee(trans, payeeName, payeesToCreate);

    normalized.push({
      payee_name: payeeName,
      trans: {
        amount: amountToInteger(trans.amount),
        payee: trans.payee,
        account: trans.account,
        date,
        notes: importNotes && notes ? notes.trim().replace(/#/g, '##') : null,
        category: categoryIds.has(trans.category) ? trans.category : null,
        imported_id,
        imported_payee: trans.imported_payee,
        cleared: trans.cleared,
        raw_synced_data: JSON.stringify(trans),
      },
    });
  }

  return { normalized, payeesToCreate };
}

function usedPayees(payeesToCreate, addsAndUpdates) {
  const usedPayeeIds = new Set(addsAndUpdates.map(t => t.payee));
  return [...payeesToCreate.values()].filter(payee =>
    usedPayeeIds.has(payee.id),
  );
}

async function createNewPayees(payeesToCreate, addsAndUpdates) {
  await batchMessages(async () => {
    for (const payee of usedPayees(payeesToCreate, addsAndUpdates)) {
      await db.insertPayee(payee);
    }
  });
}

export type MatchTransactionsOptions = {
  isBankSyncAccount?: boolean;
  enableBanking?: EnableBankingMatching;
  strictIdChecking?: boolean;
  reimportDeleted?: boolean;
  payeeNameNormalization?: PayeeNameNormalization;
};

type ImportPlan = {
  added: TransactionEntity[];
  updated: Array<{
    changes: Partial<TransactionEntity> & { id: string };
    before: TransactionEntity;
  }>;
  payees: Array<Pick<db.DbPayee, 'id' | 'name'>>;
  decisions?: EnableBankingMatching['remembered'];
  balance?: number;
  finishedAt?: string;
};

export type ReconcileTransactionsOptions = MatchTransactionsOptions & {
  isPreview?: boolean;
  defaultCleared?: boolean;
  updateDates?: boolean;
  importPlan?: ImportPlan;
};

export type ReconcileTransactionsResult = {
  added: string[];
  updated: string[];
  updatedPreview: Array<{
    transaction: TransactionEntity;
    existing?: TransactionEntity;
    ignored?: boolean;
    tombstone?: boolean;
  }>;
};

export async function reconcileTransactions(
  acctId,
  transactions,
  {
    isBankSyncAccount = false,
    enableBanking,
    strictIdChecking = true,
    isPreview = false,
    defaultCleared = true,
    updateDates = false,
    reimportDeleted,
    payeeNameNormalization,
    importPlan,
  }: ReconcileTransactionsOptions = {},
): Promise<ReconcileTransactionsResult> {
  logger.log('Performing transaction reconciliation');

  const updated = [];
  const added = [];
  const updatedPreview = [];
  const existingPayeeMap = new Map<string, string>();

  const {
    payeesToCreate,
    transactionsStep1,
    transactionsStep2,
    transactionsStep3,
  } = await matchTransactions(acctId, transactions, {
    isBankSyncAccount,
    enableBanking,
    strictIdChecking,
    reimportDeleted,
    payeeNameNormalization,
  });

  // Finally, generate & commit the changes
  for (const { trans, subtransactions, match, newId } of transactionsStep3) {
    // A skipped transaction still takes part in the matching above, so the
    // other transactions match the same way as in the import preview. It is
    // not imported or merged.
    if (trans.skipTransaction) {
      continue;
    }

    if (match && !trans.forceAddTransaction) {
      // Skip updating already reconciled (locked) transactions
      if (match.reconciled) {
        updatedPreview.push({ transaction: trans, ignored: true });
        continue;
      }

      // TODO: change the above sql query to use aql
      const existing = {
        ...match,
        cleared: match.cleared === 1,
        date: db.fromDateRepr(match.date),
      };

      // Update the transaction
      const updates = {
        imported_id: trans.imported_id || null,
        payee: existing.payee || trans.payee || null,
        category: existing.category || trans.category || null,
        imported_payee: trans.imported_payee || null,
        notes: existing.notes || trans.notes || null,
        cleared: existing.cleared || trans.cleared || false,
        raw_synced_data:
          existing.raw_synced_data ?? trans.raw_synced_data ?? null,
      };

      if (updateDates && trans.date) {
        updates['date'] = trans.date;
      }

      const fieldsToMarkUpdated = Object.keys(updates).filter(k => {
        // do not mark raw_synced_data if it's gone from falsy to falsy
        if (!existing.raw_synced_data && !trans.raw_synced_data) {
          return k !== 'raw_synced_data';
        }

        return true;
      });

      if (hasFieldsChanged(existing, updates, fieldsToMarkUpdated)) {
        updated.push({ id: existing.id, ...updates });
        if (!existingPayeeMap.has(existing.payee)) {
          const payee = await db.getPayee(existing.payee);
          existingPayeeMap.set(existing.payee, payee?.name);
        }
        existing.payee_name = existingPayeeMap.get(existing.payee);
        existing.amount = integerToAmount(existing.amount);
        updatedPreview.push({ transaction: trans, existing });
      } else {
        updatedPreview.push({ transaction: trans, ignored: true });
      }

      const clearedUpdated = existing.cleared !== updates.cleared;
      const dateUpdated =
        updateDates && trans.date && existing.date !== trans.date;

      if (existing.is_parent && (clearedUpdated || dateUpdated)) {
        const children = await db.all<Pick<db.DbViewTransaction, 'id'>>(
          'SELECT id FROM v_transactions WHERE parent_id = ?',
          [existing.id],
        );
        const childUpdates = {};

        if (clearedUpdated) {
          childUpdates['cleared'] = updates.cleared;
        }

        if (dateUpdated) {
          childUpdates['date'] = trans.date;
        }

        for (const child of children) {
          updated.push({ id: child.id, ...childUpdates });
        }
      }
    } else if (trans.tombstone) {
      if (isPreview) {
        updatedPreview.push({
          transaction: trans,
          existing: false,
          tombstone: true,
        });
      }
    } else {
      // Insert a new transaction
      const { forceAddTransaction: _forceAddTransaction, ...newTrans } = trans;
      const finalTransaction = {
        ...newTrans,
        id: newId ?? uuidv4(),
        category: trans.category || null,
        cleared: trans.cleared ?? defaultCleared,
      };

      if (subtransactions && subtransactions.length > 0) {
        added.push(...makeSplitTransaction(finalTransaction, subtransactions));
      } else {
        added.push(finalTransaction);
      }
    }
  }

  // Maintain the sort order of the server
  const now = Date.now();
  added.forEach((t, index) => {
    t.sort_order ??= now - index * TRANSACTION_SORT_INCREMENT;
  });

  if (importPlan) {
    importPlan.added.push(...added);
    for (const changes of updated) {
      const before = await db.getTransaction(changes.id);
      if (before) importPlan.updated.push({ changes, before });
    }
    importPlan.payees.push(
      ...usedPayees(payeesToCreate, [...added, ...updated]),
    );
  } else if (!isPreview) {
    await createNewPayees(payeesToCreate, [...added, ...updated]);
    await batchUpdateTransactions({ added, updated });
  }

  if (!enableBanking) {
    logger.log('Debug data for the operations:', {
      transactionsStep1,
      transactionsStep2,
      transactionsStep3,
      added,
      updated,
      updatedPreview,
    });
  }

  return {
    added: added.map(trans => trans.id),
    updated: updated.map(trans => trans.id),
    updatedPreview,
  };
}

// Ranks fuzzy-match candidates by distance from transaction date, nearest first.
// On a same-distance tie, a candidate that already carries its own imported_id
// (from a previous, unrelated sync) ranks after one that doesn't. Without this
// tie-break, picking the already-imported one would lead the fuzzy match merge
// to silently overwrite imported_id/payee/notes with this transaction's data.
export function compareFuzzyMatchCandidates(
  transactionDate: string,
  a: Pick<db.DbViewTransaction, 'date' | 'imported_id'>,
  b: Pick<db.DbViewTransaction, 'date' | 'imported_id'>,
): number {
  const aDistance = Math.abs(
    dateFns.differenceInMilliseconds(
      dateFns.parseISO(transactionDate),
      dateFns.parseISO(db.fromDateRepr(a.date)),
    ),
  );
  const bDistance = Math.abs(
    dateFns.differenceInMilliseconds(
      dateFns.parseISO(transactionDate),
      dateFns.parseISO(db.fromDateRepr(b.date)),
    ),
  );
  const aHasImportedId = Number(a.imported_id != null);
  const bHasImportedId = Number(b.imported_id != null);
  return aDistance - bDistance || aHasImportedId - bHasImportedId;
}

export async function matchTransactions(
  acctId,
  transactions,
  {
    isBankSyncAccount = false,
    enableBanking,
    strictIdChecking = true,
    reimportDeleted: reimportDeletedOverride,
    payeeNameNormalization,
  }: MatchTransactionsOptions = {},
) {
  logger.log('Performing transaction reconciliation matching');

  const reimportDeleted =
    reimportDeletedOverride !== undefined
      ? reimportDeletedOverride
      : await aqlQuery(
          q('preferences')
            .filter({ id: `sync-reimport-deleted-${acctId}` })
            .select('value'),
        ).then(data => String(data?.data?.[0]?.value ?? 'true') === 'true');

  const hasMatched = new Set();
  const exactMatchedParentIds = new Set<db.DbViewTransaction['id']>();

  const { normalized, payeesToCreate } = isBankSyncAccount
    ? await normalizeBankSyncTransactions(transactions, acctId)
    : await normalizeTransactions(transactions, acctId, {
        payeeNameNormalization,
      });

  // The first pass runs the rules, and preps data for fuzzy matching
  const accounts: db.DbAccount[] = await db.getAccounts();
  const accountsMap = new Map(accounts.map(account => [account.id, account]));

  if (enableBanking) {
    const assignments = await planEnableBankingMatches(
      acctId,
      normalized.map(({ trans }) => JSON.parse(trans.raw_synced_data)),
      reimportDeleted,
      enableBanking,
    );
    const planned = [];
    for (const [index, item] of normalized.entries()) {
      const { match, skip, newId } = assignments[index];
      const trans = skip
        ? { ...item.trans, skipTransaction: true }
        : await runRules(item.trans, accountsMap);
      planned.push({
        ...item,
        trans,
        match,
        newId,
        subtransactions: trans.subtransactions || item.subtransactions,
      });
    }
    return {
      payeesToCreate,
      transactionsStep1: planned,
      transactionsStep2: planned,
      transactionsStep3: planned,
    };
  }

  const transactionsStep1 = [];
  for (const {
    payee_name,
    trans: originalTrans,
    subtransactions,
  } of normalized) {
    // Run the rules
    const trans = await runRules(originalTrans, accountsMap);

    let match = null;
    let fuzzyDataset = null;

    // First, match with an existing transaction's imported_id. This
    // is the highest fidelity match and should always be attempted
    // first.
    if (trans.imported_id) {
      const table = reimportDeleted
        ? 'v_transactions'
        : 'v_transactions_internal';
      match = await db.first<db.DbTransaction>(
        `SELECT * FROM ${table} WHERE imported_id = ? AND account = ?`,
        [trans.imported_id, acctId],
      );

      if (match) {
        hasMatched.add(match.id);

        if (isBankSyncAccount && match.is_parent) {
          exactMatchedParentIds.add(match.id);
        }
      }
    }

    // If it didn't match, query data needed for fuzzy matching
    if (!match) {
      // Fuzzy matching looks 7 days ahead and 7 days back. This
      // needs to select all fields that need to be read from the
      // matched transaction. See the final pass below for the needed
      // fields.
      const sevenDaysBefore = db.toDateRepr(monthUtils.subDays(trans.date, 7));
      const sevenDaysAfter = db.toDateRepr(monthUtils.addDays(trans.date, 7));
      // strictIdChecking has the added behaviour of only matching on transactions with no import ID
      // if the transaction being imported has an import ID.
      if (strictIdChecking) {
        fuzzyDataset = await db.all<
          Pick<
            db.DbViewTransaction,
            | 'id'
            | 'is_parent'
            | 'parent_id'
            | 'date'
            | 'imported_id'
            | 'payee'
            | 'imported_payee'
            | 'category'
            | 'notes'
            | 'reconciled'
            | 'cleared'
            | 'amount'
          >
        >(
          `SELECT id, is_parent, parent_id, date, imported_id, payee, imported_payee, category, notes, reconciled, cleared, amount
          FROM v_transactions
          WHERE
            -- If both ids are set, and we didn't match earlier then skip dedup
            (imported_id IS NULL OR ? IS NULL)
            AND date >= ? AND date <= ? AND amount = ?
            AND account = ?`,
          [
            trans.imported_id || null,
            sevenDaysBefore,
            sevenDaysAfter,
            trans.amount || 0,
            acctId,
          ],
        );
      } else {
        fuzzyDataset = await db.all<
          Pick<
            db.DbViewTransaction,
            | 'id'
            | 'is_parent'
            | 'parent_id'
            | 'date'
            | 'imported_id'
            | 'payee'
            | 'imported_payee'
            | 'category'
            | 'notes'
            | 'reconciled'
            | 'cleared'
            | 'amount'
          >
        >(
          `SELECT id, is_parent, parent_id, date, imported_id, payee, imported_payee, category, notes, reconciled, cleared, amount
          FROM v_transactions
          WHERE date >= ? AND date <= ? AND amount = ? AND account = ?`,
          [sevenDaysBefore, sevenDaysAfter, trans.amount || 0, acctId],
        );
      }

      // Sort the matched transactions according to the distance from the original
      // transactions date. i.e. if the original transaction is in 21-02-2024 and
      // the matched transactions are: 20-02-2024, 21-02-2024, 29-02-2024 then
      // the resulting data-set should be: 21-02-2024, 20-02-2024, 29-02-2024.
      fuzzyDataset = fuzzyDataset.sort((a, b) =>
        compareFuzzyMatchCandidates(trans.date, a, b),
      );
    }

    transactionsStep1.push({
      payee_name,
      trans,
      subtransactions: trans.subtransactions || subtransactions,
      match,
      fuzzyDataset,
      newId: undefined,
    });
  }

  // Next, do the fuzzy matching. This first pass matches based on the
  // payee id. We do this in multiple passes so that higher fidelity
  // matching always happens first, i.e. a transaction should match
  // match with low fidelity if a later transaction is going to match
  // the same one with high fidelity.
  const transactionsStep2 = transactionsStep1.map(data => {
    if (!data.match && data.fuzzyDataset) {
      // Try to find one where the payees match.
      const match = data.fuzzyDataset.find(
        row =>
          !hasMatched.has(row.id) &&
          !exactMatchedParentIds.has(row.parent_id) &&
          data.trans.payee === row.payee,
      );

      if (match) {
        hasMatched.add(match.id);
        return { ...data, match };
      }
    }
    return data;
  });

  // The final fuzzy matching pass. This is the lowest fidelity
  // matching: it just find the first transaction that hasn't been
  // matched yet. Remember the dataset only contains transactions
  // around the same date with the same amount.
  const transactionsStep3 = transactionsStep2.map(data => {
    if (!data.match && data.fuzzyDataset) {
      const match = data.fuzzyDataset.find(
        row =>
          !hasMatched.has(row.id) && !exactMatchedParentIds.has(row.parent_id),
      );
      if (match) {
        hasMatched.add(match.id);
        return { ...data, match };
      }
    }
    return data;
  });

  return {
    payeesToCreate,
    transactionsStep1,
    transactionsStep2,
    transactionsStep3,
  };
}

// This is similar to `reconcileTransactions` except much simpler: it
// does not try to match any transactions. It just adds them
export async function addTransactions(
  acctId,
  transactions,
  { runTransfers = true, learnCategories = false } = {},
) {
  const added = [];

  const { normalized, payeesToCreate } = await normalizeTransactions(
    transactions,
    acctId,
    { payeeNameNormalization: 'original' },
  );

  const accounts: db.DbAccount[] = await db.getAccounts();
  const accountsMap = new Map(accounts.map(account => [account.id, account]));

  for (const { trans: originalTrans, subtransactions } of normalized) {
    // Run the rules
    const trans = await runRules(originalTrans, accountsMap);

    const finalTransaction = {
      id: uuidv4(),
      ...trans,
      account: acctId,
      cleared: trans.cleared != null ? trans.cleared : true,
    };

    // Add split transactions if they are given
    const updatedSubtransactions =
      finalTransaction.subtransactions || subtransactions;
    if (updatedSubtransactions && updatedSubtransactions.length > 0) {
      added.push(
        ...makeSplitTransaction(finalTransaction, updatedSubtransactions),
      );
    } else {
      added.push(finalTransaction);
    }
  }

  await createNewPayees(payeesToCreate, added);

  // Assign decreasing sort_order values to preserve import file order.
  // Transactions are displayed in sort_order DESC order, so first transaction
  // in the file should have the highest sort_order.
  const now = Date.now();
  added.forEach((t, index) => {
    t.sort_order ??= now - index * TRANSACTION_SORT_INCREMENT;
  });

  let newTransactions;
  if (runTransfers || learnCategories) {
    const res = await batchUpdateTransactions({
      added,
      learnCategories,
      runTransfers,
    });
    newTransactions = res.added.map(t => t.id);
  } else {
    await batchMessages(async () => {
      newTransactions = await Promise.all(
        added.map(async trans => db.insertTransaction(trans)),
      );
    });
  }
  return newTransactions;
}

async function processBankSyncDownload(
  download,
  id,
  acctRow,
  initialSync = false,
  customStartingBalance?: number,
  customStartingDate?: string,
  enableBanking?: EnableBankingMatching,
  importPlan?: ImportPlan,
) {
  // If syncing an account from sync source it must not use strictIdChecking. This allows
  // the fuzzy search to match transactions where the import IDs are different. It is a known quirk
  // that account sync sources can give two different transaction IDs even though it's the same transaction.
  const useStrictIdChecking = !acctRow.account_sync_source;

  const importTransactions = await aqlQuery(
    q('preferences')
      .filter({ id: `sync-import-transactions-${id}` })
      .select('value'),
  ).then(data => String(data?.data?.[0]?.value ?? 'true') === 'true');

  const updateDates = await aqlQuery(
    q('preferences')
      .filter({ id: `sync-update-dates-${id}` })
      .select('value'),
  ).then(data => String(data?.data?.[0]?.value ?? 'false') === 'true');

  /** Starting balance is actually the current balance of the account. */
  const {
    transactions: originalTransactions,
    startingBalance: currentBalance,
  } = download;

  if (initialSync) {
    const { transactions } = download;
    let balanceToUse = currentBalance;

    // Use custom starting balance if provided, otherwise calculate it
    if (customStartingBalance !== undefined) {
      balanceToUse = customStartingBalance;
    } else if (acctRow.account_sync_source === 'simpleFin') {
      const previousBalance = transactions.reduce((total, trans) => {
        return (
          total - parseInt(trans.transactionAmount.amount.replace('.', ''))
        );
      }, currentBalance);
      balanceToUse = previousBalance;
    } else if (acctRow.account_sync_source === 'pluggyai') {
      const currentBalance = download.startingBalance;
      const previousBalance = transactions.reduce(
        (total, trans) => total - trans.transactionAmount.amount * 100,
        currentBalance,
      );
      balanceToUse = Math.round(previousBalance);
    } else if (
      acctRow.account_sync_source === 'enableBanking' &&
      currentBalance !== null
    ) {
      const importPending = await aqlQuery(
        q('preferences')
          .filter({ id: `sync-import-pending-${id}` })
          .select('value'),
      ).then(data => String(data?.data?.[0]?.value ?? 'true') === 'true');
      const importable = importPending
        ? transactions
        : transactions.filter(trans => Boolean(trans.booked));
      const previousBalance = importable.reduce((total, trans) => {
        return total - amountToInteger(trans.transactionAmount.amount);
      }, currentBalance);
      balanceToUse = previousBalance;
    } else if (acctRow.account_sync_source === 'akahu') {
      const currentBalance = download.startingBalance;
      const previousBalance = transactions.reduce(
        (total, trans) =>
          total - amountToInteger(trans.transactionAmount.amount),
        currentBalance,
      );
      balanceToUse = Math.round(previousBalance);
    }

    const oldestTransaction = transactions[transactions.length - 1];

    // Use custom starting date if provided, otherwise use oldest transaction date or current day
    let startingBalanceDate: string;
    if (customStartingDate) {
      startingBalanceDate = customStartingDate;
    } else if (transactions.length > 0) {
      startingBalanceDate = oldestTransaction.date;
    } else {
      startingBalanceDate = monthUtils.currentDay();
    }

    async function addStartingBalance() {
      // A missing bank balance cannot be used to derive an opening balance.
      if (balanceToUse === null) return null;
      const payee = importPlan
        ? {
            id: (
              await db.first<Pick<db.DbPayee, 'id'>>(
                "SELECT id FROM payees WHERE UNICODE_LOWER(name) = 'starting balance' AND tombstone = 0",
              )
            )?.id,
            category: await getStartingBalanceCategory(),
          }
        : await getStartingBalancePayee();
      if (!payee.id && importPlan) {
        payee.id = uuidv4();
        importPlan.payees.push({ id: payee.id, name: 'Starting Balance' });
      }
      const transaction = {
        id: uuidv4(),
        account: id,
        amount: balanceToUse,
        category: acctRow.offbudget === 0 ? payee.category : null,
        payee: payee.id,
        date: startingBalanceDate,
        cleared: true,
        starting_balance_flag: true,
      };
      if (importPlan) {
        importPlan.added.push(transaction);
        return transaction.id;
      }
      return db.insertTransaction(transaction);
    }

    // Enable Banking plans the entire import before writing any transaction.
    let initialId = enableBanking ? null : await addStartingBalance();
    const result = await reconcileTransactions(id, transactions, {
      isBankSyncAccount: true,
      enableBanking,
      strictIdChecking: useStrictIdChecking,
      updateDates,
      importPlan,
    });
    if (enableBanking) initialId = await addStartingBalance();
    return {
      ...result,
      added: initialId === null ? result.added : [initialId, ...result.added],
    };
  }

  const transactions = originalTransactions.map(trans => ({
    ...trans,
    account: id,
  }));

  const result = await reconcileTransactions(
    id,
    importTransactions ? transactions : [],
    {
      isBankSyncAccount: true,
      enableBanking,
      strictIdChecking: useStrictIdChecking,
      updateDates,
      importPlan,
    },
  );

  if (currentBalance != null) {
    if (importPlan) importPlan.balance = currentBalance;
    else await updateAccountBalance(id, currentBalance);
  }

  return result;
}

type EnableBankingDownload = {
  transactions: EnableBankingPayment[];
  startingBalance: number | null;
};

type PendingEnableBankingImport = {
  revision: string;
  download: EnableBankingDownload;
  initialSync: boolean;
  customStartingBalance?: number;
  customStartingDate?: string;
  review: Review;
  snapshot: string;
};

function enableBankingConnection(account: db.DbAccount) {
  return JSON.stringify([account.id, account.bank, account.account_id]);
}

function pendingEnableBankingPath(account: db.DbAccount) {
  const id = getPrefs()?.id;
  if (!id) throw new Error('No budget is open.');
  return fs.join(
    fs.getBudgetDir(id),
    `enable-banking-${encodeURIComponent(account.id)}.json`,
  );
}

async function readPendingEnableBankingImport(account: db.DbAccount) {
  const path = pendingEnableBankingPath(account);
  if (!(await fs.exists(path))) return null;
  let contents: string;
  try {
    contents = await fs.readFile(path);
  } catch (error) {
    // The review can finish while the UI is reading its preview.
    if (!(await fs.exists(path))) return null;
    throw error;
  }
  const data: PendingEnableBankingImport & { connection: string } =
    JSON.parse(contents);
  return data.connection === enableBankingConnection(account) ? data : null;
}

async function writePendingEnableBankingImport(
  account: db.DbAccount,
  pending: PendingEnableBankingImport,
) {
  await fs.writeFile(
    pendingEnableBankingPath(account),
    JSON.stringify({
      ...pending,
      connection: enableBankingConnection(account),
    }),
  );
}

async function clearPendingEnableBankingImport(account: db.DbAccount) {
  const path = pendingEnableBankingPath(account);
  if (await fs.exists(path)) await fs.removeFile(path);
}

function enableBankingDecisionPrefix(account: db.DbAccount) {
  return `enable-banking-decision-${enableBankingConnection(account)}-`;
}

async function getEnableBankingDecisions(account: db.DbAccount) {
  const prefix = enableBankingDecisionPrefix(account);
  const rows = await db.all<Pick<db.DbPreference, 'value'>>(
    'SELECT value FROM preferences WHERE substr(id, 1, ?) = ? AND value IS NOT NULL',
    [prefix.length, prefix],
  );
  return rows.map(row =>
    JSON.parse(row.value),
  ) as EnableBankingMatching['remembered'];
}

function reviewRequired() {
  return BankSyncError(
    'ACCOUNT_NEEDS_ATTENTION',
    'ENABLE_BANKING_REVIEW_REQUIRED',
  );
}

function isLinkedEnableBankingAccount(
  account: db.DbAccount | undefined,
): account is db.DbAccount {
  return (
    !!account &&
    !account.tombstone &&
    !account.closed &&
    String(account.account_sync_source) === 'enableBanking' &&
    !!account.account_id &&
    !!account.bank
  );
}

export async function clearEnableBankingImportState(account: db.DbAccount) {
  if (String(account.account_sync_source) !== 'enableBanking') return;
  await clearPendingEnableBankingImport(account);
  const prefix = enableBankingDecisionPrefix(account);
  const rows = await db.all<Pick<db.DbPreference, 'id'>>(
    'SELECT id FROM preferences WHERE substr(id, 1, ?) = ? AND value IS NOT NULL',
    [prefix.length, prefix],
  );
  await batchMessages(async () => {
    for (const { id } of rows) {
      await db.update('preferences', { id, value: null });
    }
  });
}

type SharedDownload = Pick<
  PendingEnableBankingImport,
  'download' | 'initialSync' | 'customStartingDate' | 'customStartingBalance'
>['download'] &
  Pick<
    PendingEnableBankingImport,
    'initialSync' | 'customStartingDate' | 'customStartingBalance'
  >;

type SharedBatch =
  | { id: string; state: 'open'; download: SharedDownload }
  | { id: string; state: 'accepted'; plan: string }
  | { id: string; state: 'completed' };

function sharedImportScope(account: db.DbAccount) {
  const prefs = getPrefs();
  return prefs?.cloudFileId && prefs.groupId
    ? {
        fileId: prefs.cloudFileId,
        groupId: prefs.groupId,
        accountId: account.id,
        connectionId: account.account_id,
      }
    : null;
}

type SharedScope = NonNullable<ReturnType<typeof sharedImportScope>>;

async function sharedImportRequest<T>(
  scope: SharedScope,
  operation: { action: string } & Record<string, unknown>,
): Promise<T> {
  const token = await asyncStorage.getItem('user-token');
  const server = getServer();
  if (!token || !server) {
    throw new Error('Connect to the sync server to review this import.');
  }
  const response = await post(
    server.ENABLEBANKING_SERVER + '/shared-import',
    { ...scope, ...operation },
    { 'X-ACTUAL-TOKEN': token },
    60000,
  );
  if (response?.error_code) {
    throw BankSyncError(response.error_type, response.error_code);
  }
  return response;
}

async function readSharedImport(account: db.DbAccount, scope: SharedScope) {
  const batch = await sharedImportRequest<SharedBatch | null>(scope, {
    action: 'read',
  });
  if (batch) return batch;

  // A device upgrading from the previous release may still own a local
  // bank response. Publish it as the shared batch without a second download.
  const pending = await readPendingEnableBankingImport(account);
  if (!pending) return null;
  const { initialSync, customStartingDate, customStartingBalance, download } =
    pending;
  return sharedImportRequest<SharedBatch | null>(scope, {
    action: 'adopt',
    deviceId: await getEnableBankingDeviceId(),
    download: {
      ...download,
      initialSync,
      customStartingDate,
      customStartingBalance,
    },
  });
}

async function prepareSharedImport(
  account: db.DbAccount,
  batch: Extract<SharedBatch, { state: 'open' }>,
  confirmation?: { revision: string; choices: Choice[] },
) {
  const plan: ImportPlan = { added: [], updated: [], payees: [] };
  const {
    initialSync,
    customStartingBalance,
    customStartingDate,
    ...download
  } = batch.download;
  const snapshot = confirmation?.revision.startsWith(batch.id + ':')
    ? confirmation.revision.slice(batch.id.length + 1)
    : null;
  try {
    await processBankSyncDownload(
      structuredClone(download),
      account.id,
      account,
      initialSync && !(await getAccountOldestTransaction(account.id)),
      customStartingBalance,
      customStartingDate,
      {
        remembered: await getEnableBankingDecisions(account),
        resolution: snapshot && {
          snapshot,
          choices: confirmation.choices,
          makeId: uuidv4,
          remember: entries => {
            plan.decisions = entries;
          },
        },
      },
      plan,
    );
  } catch (error) {
    if (!(error instanceof EnableBankingReviewRequired)) throw error;
    return {
      review: { ...error.review, revision: batch.id + ':' + error.snapshot },
    };
  }
  return { plan };
}

async function encodeImportPlan(plan: ImportPlan) {
  const text = JSON.stringify(plan);
  const keyId = getPrefs()?.encryptKeyId;
  if (!keyId) return text;
  const { value, meta } = await encrypt(Buffer.from(text), keyId);
  return JSON.stringify({ ciphertext: value.toString('base64'), meta });
}

async function decodeImportPlan(text: string): Promise<ImportPlan> {
  const value = JSON.parse(text);
  const keyId = getPrefs()?.encryptKeyId;
  if (!keyId) return value;
  if (value.meta?.keyId !== keyId) {
    throw new Error('The import key has changed.');
  }
  const decoded = await decrypt(
    Buffer.from(value.ciphertext, 'base64'),
    value.meta,
  );
  return JSON.parse(decoded.toString());
}

function importReceipt(scope: SharedScope) {
  return (
    'enable-banking-completed-' +
    JSON.stringify([scope.accountId, scope.connectionId])
  );
}

function verifySharedAccount(account: db.DbAccount, scope: SharedScope) {
  const current = sharedImportScope(account);
  if (
    !isLinkedEnableBankingAccount(account) ||
    current?.fileId !== scope.fileId ||
    current.groupId !== scope.groupId ||
    current.connectionId !== scope.connectionId
  ) {
    throw new Error('The linked account changed while processing the import.');
  }
}

async function syncImportBudget(scope: SharedScope) {
  if (checkSyncingMode('offline') || checkSyncingMode('disabled')) {
    throw new Error('Budget sync must be enabled to finish the bank import.');
  }
  const result = await fullSync();
  if (
    'error' in result ||
    getPrefs()?.cloudFileId !== scope.fileId ||
    getPrefs()?.groupId !== scope.groupId
  ) {
    throw new Error('Could not sync the bank import with the budget server.');
  }
}

async function applySharedImport(
  account: db.DbAccount,
  scope: SharedScope,
  id: string,
  plan: ImportPlan,
) {
  const receipt = importReceipt(scope);
  if ((await db.select('preferences', receipt))?.value === id) {
    return { added: [], updated: [] };
  }

  const added: TransactionEntity[] = [];
  const replayed: string[] = [];
  for (const transaction of plan.added) {
    if (transaction.account !== scope.accountId) {
      throw new Error(
        'The import plan contains a payment for a different account.',
      );
    }
    const existing = await db.select('transactions', transaction.id);
    if (!existing) added.push(transaction);
    else if (!existing.tombstone) replayed.push(transaction.id);
  }

  const updated: Array<Partial<TransactionEntity> & { id: string }> = [];
  for (const { changes, before } of plan.updated) {
    const current: TransactionEntity | undefined = await db.getTransaction(
      changes.id,
    );
    if (
      !current ||
      current.tombstone ||
      current.reconciled ||
      current.account !== scope.accountId ||
      current.account !== before.account ||
      current.amount !== before.amount ||
      (current.date !== before.date && current.date !== changes.date)
    ) {
      continue;
    }
    const safeChanges = Object.entries(changes).filter(
      ([field, value]) =>
        field !== 'id' &&
        current[field] !== value &&
        (current[field] ?? null) === (before[field] ?? null),
    );
    if (safeChanges.length > 0) {
      updated.push({ id: changes.id, ...Object.fromEntries(safeChanges) });
    }
  }

  await batchMessages(async () => {
    for (const payee of plan.payees) {
      if (!(await db.select('payees', payee.id))) await db.insertPayee(payee);
    }
  });
  await batchUpdateTransactions({ added, updated, replayed });
  await batchMessages(async () => {
    const prefix = enableBankingDecisionPrefix(account);
    for (const decision of plan.decisions ?? []) {
      await db.update('preferences', {
        id: prefix + decision.evidence,
        value: JSON.stringify(decision),
      });
    }
    if (plan.balance != null) {
      await updateAccountBalance(account.id, plan.balance);
    }
    await db.update('accounts', {
      id: account.id,
      last_sync: plan.finishedAt,
      bank_sync_status: 'ok',
    });
    await db.update('preferences', { id: receipt, value: id });
  });
  return { added: added.map(t => t.id), updated: updated.map(t => t.id) };
}

type SharedImportAction =
  | { revision: string; choices: Choice[] }
  | {
      startDate: string;
      aspspName?: string;
      initialSync: boolean;
      customStartingDate?: string;
      customStartingBalance?: number;
    };

const runSharedImport = sequential(
  async (
    account: db.DbAccount,
    scope: SharedScope,
    action: SharedImportAction,
  ): Promise<{
    result?: { added: string[]; updated: string[] };
    review?: (Review & { revision: string }) | null;
  }> => {
    // Pull any edits and receipts committed by another device before planning.
    await syncImportBudget(scope);
    const previous = (await db.select('preferences', importReceipt(scope)))
      ?.value;
    const confirmation = 'revision' in action ? action : null;
    const pending = await readSharedImport(account, scope);
    const batch =
      'startDate' in action && (!pending || pending.state === 'completed')
        ? await sharedImportRequest<SharedBatch | null>(scope, {
            action: 'download',
            after: previous,
            ...action,
          })
        : pending;
    if (!batch || batch.state === 'completed') {
      if (confirmation) return { review: null };
      return { result: { added: [], updated: [] } };
    }

    const outcome = await runMutator(async () => {
      const current = await db.select('accounts', account.id);
      verifySharedAccount(current, scope);
      if (batch.state === 'accepted') {
        if (confirmation && confirmation.revision !== batch.id) {
          return { review: null };
        }
        const plan = await decodeImportPlan(batch.plan);
        return {
          result: await applySharedImport(current, scope, batch.id, plan),
        };
      }
      if (confirmation && !confirmation.revision.startsWith(batch.id + ':')) {
        return { review: null };
      }
      const prepared = await prepareSharedImport(current, batch, confirmation);
      if (!prepared.plan) {
        await db.update('accounts', {
          id: account.id,
          bank_sync_status: 'attention-required',
        });
        return { review: prepared.review };
      }
      const plan = { ...prepared.plan, finishedAt: String(Date.now()) };
      const { won } = await sharedImportRequest<{ won: boolean }>(scope, {
        action: 'confirm',
        id: batch.id,
        plan: await encodeImportPlan(plan),
      });
      if (!won) return { review: null };
      return {
        result: await applySharedImport(current, scope, batch.id, plan),
      };
    });
    if (outcome.result) {
      await syncImportBudget(scope);
      await sharedImportRequest(scope, { action: 'complete', id: batch.id });
      await clearPendingEnableBankingImport(account);
    }
    return outcome;
  },
);

export async function getEnableBankingImportReview(id: string) {
  const account = await db.select('accounts', id);
  if (!isLinkedEnableBankingAccount(account)) return null;
  const scope = sharedImportScope(account);
  if (scope) {
    const batch = await readSharedImport(account, scope);
    if (batch?.state === 'accepted') {
      return { accepted: true as const, revision: batch.id, conflicts: [] };
    }
    if (batch?.state === 'open') {
      return runMutator(async () => {
        const outcome = await prepareSharedImport(account, batch);
        return 'review' in outcome ? outcome.review : null;
      });
    }
  }
  if (scope) return null;
  const pending = await readPendingEnableBankingImport(account);
  return pending ? { revision: pending.revision, ...pending.review } : null;
}

async function applyEnableBankingImport(
  account: db.DbAccount,
  pending: Omit<PendingEnableBankingImport, 'revision' | 'review' | 'snapshot'>,
  confirmation?: { snapshot: string; choices: Choice[] },
) {
  const remembered = await getEnableBankingDecisions(account);

  let result: ReconcileTransactionsResult;
  let updatedDecisions: EnableBankingMatching['remembered'] | undefined;
  try {
    result = await processBankSyncDownload(
      structuredClone(pending.download),
      account.id,
      account,
      pending.initialSync && !(await getAccountOldestTransaction(account.id)),
      pending.customStartingBalance,
      pending.customStartingDate,
      {
        remembered,
        resolution: confirmation && {
          ...confirmation,
          makeId: uuidv4,
          remember: entries => {
            updatedDecisions = entries;
          },
        },
      },
    );
  } catch (error) {
    if (!(error instanceof EnableBankingReviewRequired)) throw error;
    // Matching detects conflicts before any transaction or balance writes.
    const review: PendingEnableBankingImport = {
      ...pending,
      revision: uuidv4(),
      snapshot: error.snapshot,
      review: error.review,
    };
    await writePendingEnableBankingImport(account, review);
    await db.update('accounts', {
      id: account.id,
      bank_sync_status: 'attention-required',
    });
    return { review: { revision: review.revision, ...review.review } };
  }

  // Allow the transaction writer's own batches to flush before committing the
  // review: transfer and split post-processing reads the newly written rows.
  if (confirmation) {
    await batchMessages(async () => {
      const prefix = enableBankingDecisionPrefix(account);
      for (const decision of updatedDecisions ?? []) {
        await db.update('preferences', {
          id: prefix + decision.evidence,
          value: JSON.stringify(decision),
        });
      }
      await db.update('accounts', {
        id: account.id,
        last_sync: String(Date.now()),
        bank_sync_status: 'ok',
      });
    });
    await clearPendingEnableBankingImport(account);
  }
  return { result };
}

export function resolveEnableBankingImport(
  id: string,
  revision: string,
  choices: Choice[],
) {
  return resolveBankImport(id, revision, choices);
}

async function resolveBankImport(
  id: string,
  revision: string,
  choices: Choice[],
) {
  const linked = await db.select('accounts', id);
  const scope =
    isLinkedEnableBankingAccount(linked) && sharedImportScope(linked);
  if (scope) return runSharedImport(linked, scope, { revision, choices });

  return runMutator(async () => {
    const account = await db.select('accounts', id);
    if (!isLinkedEnableBankingAccount(account)) {
      throw new Error('The bank account is no longer linked.');
    }
    const pending = await readPendingEnableBankingImport(account);
    if (!pending || pending.revision !== revision) {
      throw new Error('The import preview changed. Review it again.');
    }
    // An offline ZIP import has no shared budget identity. Shared budgets
    // must validate ownership even when there is no new bank request.
    if (getPrefs()?.cloudFileId) {
      await checkEnableBankingImportDevice(account.account_id);
    }
    const outcome = await applyEnableBankingImport(account, pending, {
      snapshot: pending.snapshot,
      choices,
    });
    if (!outcome.result) return { review: outcome.review };
    const { added, updated } = outcome.result;
    return { result: { added, updated } };
  });
}

const syncEnableBanking = sequential(
  async (
    id: string,
    acctId: string,
    since: string,
    initialSync: boolean,
    customStartingBalance?: number,
    customStartingDate?: string,
  ) => {
    const account = await db.select('accounts', id);
    if (!isLinkedEnableBankingAccount(account)) {
      throw new Error('The bank account is no longer linked.');
    }
    if (account.account_id !== acctId) {
      throw new Error('The bank account changed before downloading.');
    }
    const scope = sharedImportScope(account);
    const bank = await db.select('banks', account.bank);
    if (scope) {
      const outcome = await runSharedImport(account, scope, {
        startDate: since,
        aspspName: bank?.name,
        initialSync,
        customStartingDate,
        customStartingBalance,
      });
      if (!outcome.result) throw reviewRequired();
      return { ...outcome.result, updatedPreview: [] };
    }
    if (await getEnableBankingImportReview(id)) throw reviewRequired();
    // A client connected to an older server must fail before reaching its
    // unguarded transactions endpoint.
    await checkEnableBankingImportDevice(acctId);
    const download = await downloadEnableBankingTransactions(
      acctId,
      since,
      bank?.name,
    );
    if (!download) throw BankSyncError('NO_DATA', 'NO_DATA');

    const applied = await runMutator(async () => {
      const current = await db.select('accounts', id);
      if (
        !isLinkedEnableBankingAccount(current) ||
        current.bank !== account.bank ||
        current.account_id !== acctId
      ) {
        throw new Error('The bank account changed while downloading.');
      }
      if (await getEnableBankingImportReview(id)) throw reviewRequired();
      const oldest = await getAccountOldestTransaction(id);
      return applyEnableBankingImport(current, {
        download: {
          transactions: download.transactions,
          startingBalance: download.startingBalance,
        },
        initialSync: initialSync && !oldest,
        customStartingBalance,
        customStartingDate,
      });
    });
    if (!applied.result) throw reviewRequired();
    return applied.result;
  },
);

export async function syncAccount(
  userId: string | undefined,
  userKey: string | undefined,
  id: string,
  acctId: string,
  bankId: string,
  customStartingDate?: string,
  customStartingBalance?: number,
  fileId?: string,
) {
  const acctRow = await db.select('accounts', id);

  const syncStartDate =
    customStartingDate ?? (await getAccountSyncStartDate(id));
  const oldestTransaction = await getAccountOldestTransaction(id);
  const newAccount = oldestTransaction == null;

  let download;
  if (acctRow.account_sync_source === 'simpleFin') {
    download = await downloadSimpleFinTransactions(
      acctId,
      syncStartDate,
      fileId,
    );
  } else if (acctRow.account_sync_source === 'pluggyai') {
    download = await downloadPluggyAiTransactions(
      acctId,
      syncStartDate,
      fileId,
    );
  } else if (acctRow.account_sync_source === 'akahu') {
    download = await downloadAkahuTransactions(acctId, syncStartDate);
  } else if (acctRow.account_sync_source === 'goCardless') {
    download = await downloadGoCardlessTransactions(
      userId,
      userKey,
      acctId,
      bankId,
      syncStartDate,
      newAccount,
    );
  } else if (acctRow.account_sync_source === 'enableBanking') {
    return syncEnableBanking(
      id,
      acctId,
      syncStartDate,
      newAccount,
      customStartingBalance,
      customStartingDate,
    );
  } else {
    throw new Error(
      `Unrecognized bank-sync provider: ${acctRow.account_sync_source}`,
    );
  }

  return runMutator(() =>
    processBankSyncDownload(
      download,
      id,
      acctRow,
      newAccount,
      customStartingBalance,
      customStartingDate,
    ),
  );
}

export async function simpleFinBatchSync(
  accounts: Array<Pick<AccountEntity, 'id' | 'account_id'>>,
  fileId?: string,
) {
  const startDates = await Promise.all(
    accounts.map(async a => getAccountSyncStartDate(a.id)),
  );

  const res = await downloadSimpleFinTransactions(
    accounts.map(a => a.account_id),
    startDates,
    fileId,
  );

  if (!res) {
    return accounts.map(account => ({
      accountId: account.id,
      res: {
        error_type: 'NO_DATA',
        error_code: 'NO_DATA',
      },
    }));
  }

  const promises = [];
  for (let i = 0; i < accounts.length; i++) {
    const account = accounts[i];
    const download = res[account.account_id];

    if (!download || Object.keys(download).length === 0) {
      promises.push(
        Promise.resolve({
          accountId: account.id,
          res: {
            error_type: 'ACCOUNT_MISSING',
            error_code: 'ACCOUNT_MISSING',
          },
        }),
      );
      continue;
    }

    const acctRow = await db.select('accounts', account.id);
    const oldestTransaction = await getAccountOldestTransaction(account.id);
    const newAccount = oldestTransaction == null;

    if (download.error_code) {
      promises.push(
        Promise.resolve({
          accountId: account.id,
          res: download,
        }),
      );

      continue;
    }

    if (!download.transactions) {
      promises.push(
        Promise.resolve({
          accountId: account.id,
          res: {
            error_type: 'ACCOUNT_MISSING',
            error_code: 'ACCOUNT_MISSING',
          },
        }),
      );
      continue;
    }

    promises.push(
      runMutator(() =>
        processBankSyncDownload(download, account.id, acctRow, newAccount),
      )
        .then(res => ({
          accountId: account.id,
          res,
        }))
        .catch(err => ({
          accountId: account.id,
          res: {
            error_type: err?.category || 'INTERNAL_ERROR',
            error_code: err?.code || 'INTERNAL_ERROR',
          },
        })),
    );
  }

  return await Promise.all(promises);
}
