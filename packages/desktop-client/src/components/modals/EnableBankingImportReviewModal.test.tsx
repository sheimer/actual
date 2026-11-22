import React from 'react';

import { send } from '@actual-app/core/platform/client/connection';
import type { Review } from '@actual-app/core/server/accounts/enable-banking-match';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, test, vi } from 'vitest';

import { TestProviders } from '#mocks';

import { EnableBankingImportReviewModal } from './EnableBankingImportReviewModal';

vi.mock('@actual-app/core/platform/client/connection', () => ({
  send: vi.fn(),
}));

test('reviews a revised import before sending decisions for the latest revision', async () => {
  const user = userEvent.setup();
  const candidate = {
    id: 'original',
    date: 20261120,
    amount: -1234,
    payee: 'Synthetic Market',
    notes: 'Original note',
    deleted: false,
    reconciled: false,
    split: false,
    transfer: false,
  };
  const conflict = {
    index: 0,
    date: '2026-11-20',
    amount: -1234,
    currency: 'EUR',
    payee: 'Synthetic Market Details',
    notes: 'Receipt 42',
    candidates: [candidate],
  };
  const initial = {
    revision: 'one',
    conflicts: [
      conflict,
      {
        ...conflict,
        index: 1,
        payee: 'Synthetic Market Annex',
      },
    ],
  } satisfies Review & { revision: string };
  vi.mocked(send).mockResolvedValueOnce(initial);
  vi.mocked(send).mockResolvedValueOnce({
    review: { revision: 'two', conflicts: [conflict] },
  });
  vi.mocked(send).mockResolvedValueOnce({
    result: { added: [], updated: ['original'] },
  });

  render(
    <TestProviders>
      <EnableBankingImportReviewModal accountId="checking" />
    </TestProviders>,
  );

  const first = within(
    await screen.findByRole('group', { name: conflict.payee }),
  ).getByRole('combobox');
  const second = within(
    screen.getByRole('group', { name: 'Synthetic Market Annex' }),
  ).getByRole('combobox');
  const apply = screen.getByRole('button', { name: 'Apply bank import' });
  expect(apply).toBeDisabled();
  await user.selectOptions(first, 'match:original');
  expect(
    within(second).getByRole('option', { name: /original note/i }),
  ).toBeDisabled();
  await user.selectOptions(second, 'add');
  await user.click(apply);

  expect(send).toHaveBeenCalledWith('enablebanking-import-resolve', {
    id: 'checking',
    revision: 'one',
    choices: [
      { index: 0, action: 'match', transactionId: 'original' },
      { index: 1, action: 'add' },
    ],
  });
  await screen.findByText(
    'The account changed. Review the updated import before applying.',
  );
  expect(screen.getByRole('combobox')).toHaveValue('');
  expect(
    screen.getByRole('button', { name: 'Apply bank import' }),
  ).toBeDisabled();
  await user.selectOptions(screen.getByRole('combobox'), 'skip');
  await user.click(screen.getByRole('button', { name: 'Apply bank import' }));

  expect(send).toHaveBeenLastCalledWith('enablebanking-import-resolve', {
    id: 'checking',
    revision: 'two',
    choices: [{ index: 0, action: 'skip' }],
  });
});
