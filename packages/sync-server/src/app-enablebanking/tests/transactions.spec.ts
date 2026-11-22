import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  mockDebitTransaction,
  mockPendingTransaction,
  mockPendingTransactionNoDate,
} from '#app-enablebanking/services/tests/fixtures';
import { EnableBankingError } from '#app-enablebanking/utils/errors';

// Mock all external dependencies before importing the app (mirrors
// poll-auth.spec.ts).
vi.mock('../../services/secrets-service', () => ({
  SecretName: {
    enablebanking_applicationId: 'enablebanking_applicationId',
    enablebanking_secretKey: 'enablebanking_secretKey',
  },
  secretsService: {
    get: vi.fn(() => 'test-value'),
    set: vi.fn(),
  },
}));

vi.mock('../utils/jwt', () => ({
  getJWT: vi.fn(() => 'mock-jwt-token'),
}));

vi.mock('../../util/middlewares', () => ({
  requestLoggerMiddleware: (_req: unknown, _res: unknown, next: () => void) =>
    next(),
  validateSessionMiddleware: (_req: unknown, _res: unknown, next: () => void) =>
    next(),
}));

vi.mock('../../app-gocardless/util/handle-error', () => ({
  handleError:
    (fn: Function) =>
    (req: unknown, res: { send: (data: unknown) => void }) => {
      Promise.resolve(fn(req, res)).catch((err: Error) => {
        res.send({
          status: 'ok',
          data: {
            error_code: 'INTERNAL_ERROR',
            error_type: err.message || 'internal-error',
          },
        });
      });
    },
}));

// Mock provider requests (the service is stubbed below, this just guards stray calls)
vi.mock('undici', () => ({ fetch: vi.fn() }));

vi.mock('#account-db', () => ({
  getAccountDb: () => accountDb,
  isAdmin: () => false,
}));

const { openDatabase } = await import('#db');
const { createEnableBankingImportDevicesTable } =
  await import('../import-device');
let accountDb: ReturnType<typeof openDatabase>;
const ownerId = '8fbac2eb-08c1-4c94-8f38-8f52821a013c';
const otherId = '377d70d4-8dc5-4577-96fa-03ec09cb7dae';

const { handlers } = await import('../app-enablebanking');
const { enableBankingService } =
  await import('../services/enablebanking-service');

const app = express();
app.set('trust proxy', true);
app.use(express.json());
app.use('/', handlers);

const ids = (txns: Array<{ transactionId: string }>) =>
  txns.map(t => t.transactionId);

describe('POST /transactions', () => {
  beforeEach(() => {
    accountDb = openDatabase(':memory:');
    createEnableBankingImportDevicesTable();
    accountDb.mutate(
      'INSERT INTO enable_banking_import_devices VALUES (?, ?)',
      ['acc-1', ownerId],
    );
    vi.spyOn(enableBankingService, 'getBalances').mockResolvedValue({
      balances: [],
    });
  });

  afterEach(() => {
    accountDb.close();
    vi.restoreAllMocks();
  });

  it('rejects two competing devices before making a bank request', async () => {
    const getBalances = vi
      .spyOn(enableBankingService, 'getBalances')
      .mockResolvedValue({ balances: [] });
    const getTransactions = vi
      .spyOn(enableBankingService, 'getAllTransactions')
      .mockResolvedValue([]);
    const claims = await Promise.all(
      [ownerId, otherId].map(deviceId =>
        request(app)
          .post('/import-device')
          .send({ accountId: 'new-account', deviceId, claim: true }),
      ),
    );
    const denied = claims.findIndex(
      claim =>
        claim.body.data.error_code === 'ENABLE_BANKING_IMPORT_DEVICE_MISMATCH',
    );
    expect(denied).toBeGreaterThanOrEqual(0);
    expect(claims[1 - denied].body.data).toEqual({});
    const deniedId = [ownerId, otherId][denied];
    const allowed = [ownerId, otherId][1 - denied];

    for (const [accountId, deviceId, code] of [
      ['new-account', deniedId, 'ENABLE_BANKING_IMPORT_DEVICE_MISMATCH'],
      ['unclaimed-account', allowed, 'ENABLE_BANKING_IMPORT_DEVICE_REQUIRED'],
      ['new-account', undefined, 'ENABLE_BANKING_IMPORT_DEVICE_REQUIRED'],
    ]) {
      const response = await request(app).post('/transactions').send({
        accountId,
        deviceId,
        startDate: '2026-03-01',
      });
      expect(response.body.data.error_code).toBe(code);
    }
    expect(getTransactions).not.toHaveBeenCalled();
    expect(getBalances).not.toHaveBeenCalled();
    const response = await request(app).post('/transactions').send({
      accountId: 'new-account',
      deviceId: allowed,
      startDate: '2026-03-01',
    });
    expect(response.body.data.transactions.all).toEqual([]);
    expect(getTransactions).toHaveBeenCalledTimes(1);
  });

  it('skips a date-less pending transaction while keeping valid booked and pending ones', async () => {
    // mockPendingTransactionNoDate normalizes to date '' — the record that would
    // otherwise abort the whole sync when Actual's client tries to insert it.
    vi.spyOn(enableBankingService, 'getAllTransactions').mockResolvedValue([
      mockDebitTransaction,
      mockPendingTransaction,
      mockPendingTransactionNoDate,
    ]);

    const res = await request(app)
      .post('/transactions')
      .send({ accountId: 'acc-1', deviceId: ownerId, startDate: '2026-03-01' });

    expect(res.body.status).toBe('ok');

    const { all, booked, pending } = res.body.data.transactions;
    // The unimportable record is dropped (proves the fix)...
    expect(ids(all)).toEqual(['ref-002', 'tx-003']);
    expect(ids(all)).not.toContain('tx-no-date');
    // ...while the valid booked and valid (dated) pending entries still import
    // and bucket correctly (no regression).
    expect(ids(booked)).toEqual(['ref-002']);
    expect(ids(pending)).toEqual(['tx-003']);
  });

  it('keeps every transaction when all are importable', async () => {
    vi.spyOn(enableBankingService, 'getAllTransactions').mockResolvedValue([
      mockDebitTransaction,
      mockPendingTransaction,
    ]);

    const res = await request(app)
      .post('/transactions')
      .send({ accountId: 'acc-1', deviceId: ownerId, startDate: '2026-03-01' });

    expect(res.body.data.transactions.all).toHaveLength(2);
    expect(ids(res.body.data.transactions.all)).toEqual(['ref-002', 'tx-003']);
  });

  it('gives two identical transactions without a bank id distinct ids', async () => {
    const withoutId = { ...mockDebitTransaction, entry_reference: undefined };
    vi.spyOn(enableBankingService, 'getAllTransactions').mockResolvedValue([
      withoutId,
      withoutId,
    ]);

    const res = await request(app)
      .post('/transactions')
      .send({ accountId: 'acc-1', deviceId: ownerId, startDate: '2026-03-01' });

    const [first, second] = ids(res.body.data.transactions.all);
    expect(first).toBeTruthy();
    expect(second).toBeTruthy();
    expect(first).not.toBe(second);
  });

  it('still imports transactions when the balance request fails', async () => {
    // Some banks reject the balances call outright. That must not stop the
    // transactions from being fetched.
    vi.spyOn(enableBankingService, 'getBalances').mockRejectedValue(
      new EnableBankingError('Error interacting with ASPSP', 'INVALID_INPUT'),
    );
    vi.spyOn(enableBankingService, 'getAllTransactions').mockResolvedValue([
      mockDebitTransaction,
    ]);

    const res = await request(app)
      .post('/transactions')
      .send({ accountId: 'acc-1', deviceId: ownerId, startDate: '2026-03-01' });

    expect(res.body.status).toBe('ok');
    expect(ids(res.body.data.transactions.all)).toEqual(['ref-002']);
    expect(res.body.data.balances).toEqual([]);
    expect(res.body.data.startingBalance).toBeNull();
  });

  it('sends an IPv4-mapped client address to the bank as plain IPv4', async () => {
    // Node reports IPv4 clients as `::ffff:1.2.3.4` on dual-stack sockets and
    // some banks reject that form of the PSU address.
    const getAllTransactions = vi
      .spyOn(enableBankingService, 'getAllTransactions')
      .mockResolvedValue([]);

    await request(app)
      .post('/transactions')
      .set('X-Forwarded-For', '::ffff:136.243.37.31')
      .send({ accountId: 'acc-1', deviceId: ownerId, startDate: '2026-03-01' });

    expect(getAllTransactions).toHaveBeenCalledWith(
      'acc-1',
      '2026-03-01',
      expect.any(String),
      expect.objectContaining({ 'Psu-Ip-Address': '136.243.37.31' }),
    );
  });
});
