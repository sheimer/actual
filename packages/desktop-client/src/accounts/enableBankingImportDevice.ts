import { send } from '@actual-app/core/platform/client/connection';
import type { AccountEntity } from '@actual-app/core/types/models';
import type { TFunction } from 'i18next';

import {
  addNotification,
  removeNotification,
} from '#notifications/notificationsSlice';
import type { AppDispatch } from '#redux/store';

import { markAccountSuccess } from './accountsSlice';

function notificationId(accountId: AccountEntity['id']) {
  return `enable-banking-import-device-${accountId}`;
}

export async function claimEnableBankingImportDevice(
  dispatch: AppDispatch,
  accountId: AccountEntity['id'],
) {
  await send('enablebanking-claim-import-device', { id: accountId });
  dispatch(markAccountSuccess({ id: accountId }));
  dispatch(removeNotification({ id: notificationId(accountId) }));
}

export function notifyEnableBankingImportDeviceRequired(
  dispatch: AppDispatch,
  t: TFunction,
  accountId: AccountEntity['id'],
  accountName?: string,
) {
  dispatch(
    addNotification({
      notification: {
        id: notificationId(accountId),
        type: 'error',
        title: accountName,
        message: t('Choose an import device for this Enable Banking account.'),
        button: {
          title: t('Use this device'),
          action: async () => {
            try {
              await claimEnableBankingImportDevice(dispatch, accountId);
            } catch {
              dispatch(
                addNotification({
                  notification: {
                    type: 'error',
                    message: t(
                      'Could not select this device. Another device may already be selected.',
                    ),
                  },
                }),
              );
            }
          },
        },
      },
    }),
  );
}
