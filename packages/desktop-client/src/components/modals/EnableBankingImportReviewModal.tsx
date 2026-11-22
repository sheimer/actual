import React, { useId, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';

import { Button } from '@actual-app/components/button';
import { Text } from '@actual-app/components/text';
import { theme } from '@actual-app/components/theme';
import { View } from '@actual-app/components/view';
import { send } from '@actual-app/core/platform/client/connection';
import type {
  Choice,
  Review,
} from '@actual-app/core/server/accounts/enable-banking-match';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { accountQueries } from '#accounts';
import { markAccountSuccess } from '#accounts/accountsSlice';
import { Modal, ModalButtons, ModalHeader } from '#components/common/Modal';
import { FinancialText } from '#components/FinancialText';
import { useFormat } from '#hooks/useFormat';
import { useDispatch } from '#redux';

export function EnableBankingImportReviewModal({
  accountId,
}: {
  accountId: string;
}) {
  const titleId = useId();
  const dispatch = useDispatch();
  const queryClient = useQueryClient();
  const queryKey = ['enablebanking-import-review', accountId];
  const review = useQuery({
    queryKey,
    queryFn: () => send('enablebanking-import-review', { id: accountId }),
    retry: false,
  });

  const pendingImport = review.data;
  const apply = useMutation({
    mutationFn: ({
      revision,
      choices,
    }: {
      revision: string;
      choices: Choice[];
    }) =>
      send('enablebanking-import-resolve', {
        id: accountId,
        revision,
        choices,
      }),
    onSuccess: response => {
      if (response.review) {
        queryClient.setQueryData(queryKey, response.review);
      } else {
        queryClient.setQueryData(queryKey, null);
        dispatch(markAccountSuccess({ id: accountId }));
        void queryClient.invalidateQueries({
          queryKey: accountQueries.lists(),
        });
      }
    },
    onError: () => {
      void review.refetch();
    },
  });

  return (
    <Modal
      name="enablebanking-import-review"
      presentation="sheet"
      ariaLabelledBy={titleId}
      style={{ width: 560, maxWidth: '100%', minWidth: 0 }}
    >
      {({ state }) => (
        <>
          <ModalHeader
            title={
              <span id={titleId}>
                <Trans>Review bank import</Trans>
              </span>
            }
          />
          {review.isPending ? (
            <Text role="status">
              <Trans>Loading bank import…</Trans>
            </Text>
          ) : review.isError && !pendingImport ? (
            <Text role="alert">
              <Trans>Could not load the bank import.</Trans>
            </Text>
          ) : pendingImport ? (
            <ReviewForm
              key={pendingImport.revision}
              review={pendingImport}
              busy={apply.isPending || review.isFetching}
              failed={apply.isError}
              refreshed={!!apply.data?.review}
              onClose={() => state.close()}
              onApply={choices =>
                apply.mutate(
                  { revision: pendingImport.revision, choices },
                  {
                    onSuccess: response => {
                      if (response.result) state.close();
                    },
                  },
                )
              }
            />
          ) : (
            <Text>
              <Trans>
                There is no bank import waiting for review on this device.
              </Trans>
            </Text>
          )}
          {!pendingImport && (
            <ModalButtons>
              {review.isError && (
                <Button onPress={() => void review.refetch()}>
                  <Trans>Try again</Trans>
                </Button>
              )}
              <Button onPress={() => state.close()}>
                <Trans>Close</Trans>
              </Button>
            </ModalButtons>
          )}
        </>
      )}
    </Modal>
  );
}

function ReviewForm({
  review,
  busy,
  failed,
  refreshed,
  onClose,
  onApply,
}: {
  review: Review;
  busy: boolean;
  failed: boolean;
  refreshed: boolean;
  onClose: () => void;
  onApply: (choices: Choice[]) => void;
}) {
  const { t } = useTranslation();
  const format = useFormat();
  const [choices, setChoices] = useState<Record<number, string>>({});

  return (
    <>
      <Text>
        <Trans>
          Choose how to handle each payment. Actual will use the downloaded bank
          response and remember your choices for payments it recognizes again.
        </Trans>
      </Text>
      {refreshed && (
        <Text role="status">
          <Trans>
            The account changed. Review the updated import before applying.
          </Trans>
        </Text>
      )}
      {failed && (
        <Text role="alert" style={{ color: theme.errorText }}>
          <Trans>
            Could not apply the bank import. Review your choices and try again.
          </Trans>
        </Text>
      )}
      {review.conflicts.length === 0 && (
        <Text>
          <Trans>The import is ready to apply.</Trans>
        </Text>
      )}
      <View
        style={{
          gap: 12,
          marginBlock: 12,
          overflowY: 'auto',
          maxHeight: '48dvh',
        }}
      >
        {review.conflicts.map(conflict => {
          const { index, date, payee, notes, amount, currency, candidates } =
            conflict;
          return (
            <fieldset
              key={index}
              style={{
                border: `1px solid ${theme.tableBorder}`,
                minWidth: 0,
                borderRadius: 4,
              }}
            >
              <legend>{payee || t('Unknown payee')}</legend>
              <View style={{ gap: 6 }}>
                <Text>
                  {date}
                  {' · '}
                  <FinancialText>
                    {format(amount / 100, 'number')} {currency}
                  </FinancialText>
                </Text>
                {notes && (
                  <Text style={{ overflowWrap: 'anywhere' }}>{notes}</Text>
                )}
                <label>
                  <Text>
                    <Trans>Action for this payment</Trans>
                  </Text>
                  <select
                    disabled={busy}
                    value={choices[index] ?? ''}
                    onChange={event => {
                      const value = event.target.value;
                      setChoices(previous => ({ ...previous, [index]: value }));
                    }}
                    style={{
                      width: '100%',
                      marginTop: 4,
                      padding: 6,
                      backgroundColor: theme.tableBackground,
                      color: theme.pageText,
                      border: `1px solid ${theme.tableBorder}`,
                      borderRadius: 4,
                    }}
                  >
                    <option value="">
                      <Trans>Choose an action</Trans>
                    </option>
                    {candidates.map(candidate => {
                      const value = `match:${candidate.id}`;
                      const rawDate = String(candidate.date);
                      const candidateDate = `${rawDate.slice(0, 4)}-${rawDate.slice(4, 6)}-${rawDate.slice(6)}`;
                      const state = [
                        candidate.deleted && t('Deleted'),
                        candidate.reconciled && t('Reconciled'),
                        candidate.split && t('Split'),
                        candidate.transfer && t('Transfer'),
                      ]
                        .filter(Boolean)
                        .join(', ');
                      const description = [
                        candidate.payee || t('Unknown payee'),
                        candidateDate,
                        format(candidate.amount, 'financial'),
                        candidate.notes,
                        state,
                      ]
                        .filter(Boolean)
                        .join(' · ');
                      return (
                        <option
                          key={candidate.id}
                          value={value}
                          disabled={Object.entries(choices).some(
                            ([otherIndex, choice]) =>
                              Number(otherIndex) !== index && choice === value,
                          )}
                        >
                          {t('Match existing: {{description}}', {
                            description,
                          })}
                        </option>
                      );
                    })}
                    <option value="add">
                      <Trans>Add as a new transaction</Trans>
                    </option>
                    <option value="skip">
                      <Trans>Exclude this payment from the import</Trans>
                    </option>
                  </select>
                </label>
              </View>
            </fieldset>
          );
        })}
      </View>
      <ModalButtons>
        <Button isDisabled={busy} onPress={onClose}>
          <Trans>Review later</Trans>
        </Button>
        <Button
          variant="primary"
          isDisabled={
            busy || review.conflicts.some(({ index }) => !choices[index])
          }
          onPress={() =>
            onApply(
              review.conflicts.map(({ index }) => {
                const value = choices[index];
                if (value === 'add' || value === 'skip') {
                  return { index, action: value };
                }
                return {
                  index,
                  action: 'match',
                  transactionId: value.slice('match:'.length),
                };
              }),
            )
          }
        >
          {busy ? t('Applying…') : t('Apply bank import')}
        </Button>
      </ModalButtons>
    </>
  );
}
