import React from 'react';

import { send } from '@actual-app/core/platform/client/connection';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, test, vi } from 'vitest';

import { Notifications } from '#components/Notifications';
import { useAccounts } from '#hooks/useAccounts';
import { createTestAppStore, TestProviders } from '#mocks';

import { useSyncAccountsMutation } from './mutations';

// The shared test setup imports the app store before this file's mocks.
vi.hoisted(() => vi.resetModules());

vi.mock(
  '@actual-app/core/platform/client/connection',
  async importOriginal => ({
    ...(await importOriginal()),
    send: vi.fn(),
  }),
);
vi.mock('#hooks/useAccounts');

function SyncTestAccount() {
  const sync = useSyncAccountsMutation();
  return (
    <button onClick={() => sync.mutate({ id: 'test-account' })}>
      Bank Sync
    </button>
  );
}

test('selects the import device from the bank-sync notification', async () => {
  const store = createTestAppStore();
  vi.mocked(useAccounts).mockReturnValue({
    data: [{ id: 'test-account', name: 'Synthetic Checking' }],
  } as ReturnType<typeof useAccounts>);
  vi.mocked(send).mockResolvedValueOnce({
    newTransactions: [],
    matchedTransactions: [],
    updatedAccounts: [],
    errors: [
      {
        type: 'SyncError',
        accountId: 'test-account',
        category: 'ENABLE_BANKING_IMPORT_DEVICE_REQUIRED',
        code: 'ENABLE_BANKING_IMPORT_DEVICE_REQUIRED',
        message: 'Choose an import device for this Enable Banking account.',
      },
    ],
  });
  vi.mocked(send).mockResolvedValueOnce('ok');

  render(
    <TestProviders store={store}>
      <SyncTestAccount />
      <Notifications />
    </TestProviders>,
  );
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'Bank Sync' }));
  const notice = await screen.findByRole('alert');
  expect(notice).toHaveTextContent('Synthetic Checking');
  expect(notice).toHaveTextContent(
    'Choose an import device for this Enable Banking account.',
  );
  await user.click(
    within(notice).getByRole('button', { name: 'Use this device' }),
  );

  expect(vi.mocked(send).mock.calls).toEqual([
    ['accounts-bank-sync', { ids: ['test-account'] }],
    ['enablebanking-claim-import-device', { id: 'test-account' }],
  ]);
  await waitFor(() =>
    expect(screen.queryByRole('alert')).not.toBeInTheDocument(),
  );
  expect(
    store.getState().account.failedAccounts['test-account'],
  ).toBeUndefined();
});

test('opens the account review from the bank-sync warning', async () => {
  const store = createTestAppStore();
  vi.mocked(send).mockClear();
  vi.mocked(useAccounts).mockReturnValue({
    data: [{ id: 'test-account', name: 'Synthetic Checking' }],
  } as ReturnType<typeof useAccounts>);
  vi.mocked(send).mockResolvedValueOnce({
    newTransactions: [],
    matchedTransactions: [],
    updatedAccounts: [],
    errors: [
      {
        type: 'SyncError',
        accountId: 'test-account',
        category: 'ACCOUNT_NEEDS_ATTENTION',
        code: 'ENABLE_BANKING_REVIEW_REQUIRED',
        message:
          'Review the downloaded Enable Banking transactions before importing.',
      },
    ],
  });

  render(
    <TestProviders store={store}>
      <SyncTestAccount />
      <Notifications />
    </TestProviders>,
  );
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'Bank Sync' }));
  const review = await screen.findByRole('button', {
    name: 'Review bank import',
  });
  await user.click(review);

  expect(store.getState().modals.modalStack).toMatchObject([
    {
      name: 'enablebanking-import-review',
      options: { accountId: 'test-account' },
    },
  ]);
  expect(vi.mocked(send).mock.calls).toEqual([
    ['accounts-bank-sync', { ids: ['test-account'] }],
  ]);
  await waitFor(() => expect(review).not.toBeInTheDocument());
});
