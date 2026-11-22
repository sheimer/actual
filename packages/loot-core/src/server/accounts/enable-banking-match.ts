import { differenceInDays, parseISO } from 'date-fns';
import { v5 as uuidv5 } from 'uuid';

import * as db from '#server/db';
import { amountToInteger } from '#shared/util';
import type { BankSyncTransaction } from '#types/models';

export type EnableBankingPayment = BankSyncTransaction & {
  date: string;
  payeeName: string;
  booked: boolean;
  notes?: string;
  transaction_date?: string;
  remittance_information?: string[];
};

type Existing = db.DbViewTransaction & {
  raw_synced_data: string | null;
  payee_name: string | null;
};
export type Choice =
  | { index: number; action: 'match'; transactionId: string }
  | { index: number; action: 'add' | 'skip' };
type Target = { id: string } & (
  | { source: string }
  | { date: number; amount: number }
);
type Remembered = { evidence: string; targets: Array<Target | null> };
export type Review = {
  conflicts: Array<{
    index: number;
    date: string;
    amount: number;
    payee: string;
    notes: string;
    currency: string;
    candidates: Array<{
      id: string;
      date: number;
      amount: number;
      payee: string | null;
      notes: string | null;
      deleted: boolean;
      reconciled: boolean;
      split: boolean;
      transfer: boolean;
    }>;
  }>;
};

export class EnableBankingReviewRequired extends Error {
  constructor(
    public review: Review,
    public snapshot: string,
  ) {
    super(
      'Review the downloaded Enable Banking transactions before importing.',
    );
  }
}

function evidence(payment: EnableBankingPayment) {
  return uuidv5(
    JSON.stringify([
      payment.transaction_date || payment.date,
      amountToInteger(Number(payment.transactionAmount.amount)),
      payment.transactionAmount.currency,
      payment.payeeName,
      payment.remittance_information ?? payment.notes ?? '',
    ]),
    uuidv5.URL,
  );
}

function readSource(raw: string | null): EnableBankingPayment | null {
  if (!raw) return null;
  try {
    const source: EnableBankingPayment = JSON.parse(raw);
    return source?.date &&
      typeof source.transactionAmount?.amount === 'string' &&
      Number.isFinite(Number(source.transactionAmount.amount))
      ? source
      : null;
  } catch {
    return null;
  }
}

type Assignment = {
  match: Existing | null;
  skip?: boolean;
  newId?: string;
};

type Resolution = {
  snapshot: string;
  choices: Choice[];
  makeId: () => string;
  remember: (entries: Remembered[]) => void;
};

export type EnableBankingMatching = {
  remembered: Remembered[];
  resolution?: Resolution;
};

export async function planEnableBankingMatches(
  accountId: string,
  payments: EnableBankingPayment[],
  reimportDeleted: boolean,
  { remembered, resolution }: EnableBankingMatching,
) {
  const rows = await db.all<Existing>(
    `SELECT v.*, t.raw_synced_data, p.name AS payee_name FROM v_transactions_internal v
     JOIN transactions t ON t.id = v.id
     LEFT JOIN v_payees p ON p.id = v.payee
     WHERE v.account = ? AND v.is_child = 0 AND NOT COALESCE(v.starting_balance_flag, 0)
       AND (v.tombstone = 0 OR ? = 0) ORDER BY v.id`,
    [accountId, Number(reimportDeleted)],
  );

  const existing = rows.map(row => {
    const source = readSource(row.raw_synced_data);
    return { row, source, key: source ? evidence(source) : null };
  });
  const existingById = new Map(
    existing.map(candidate => [candidate.row.id, candidate]),
  );
  const existingByEvidence = new Map<string, typeof existing>();
  const existingByAmount = new Map<number, typeof existing>();
  for (const candidate of existing) {
    const { row, source, key } = candidate;
    const amount = source
      ? amountToInteger(Number(source.transactionAmount.amount))
      : row.amount;
    const byAmount = existingByAmount.get(amount) ?? [];
    byAmount.push(candidate);
    existingByAmount.set(amount, byAmount);
    if (key) {
      const byEvidence = existingByEvidence.get(key) ?? [];
      byEvidence.push(candidate);
      existingByEvidence.set(key, byEvidence);
    }
  }
  const assignments: Assignment[] = payments.map(() => ({ match: null }));
  const groups = new Map<string, number[]>();
  const conflicts: Review['conflicts'] = [];
  const reserved = new Set<string>();
  const conflictEvidence = new Set<string>();
  const memory = new Map(remembered.map(entry => [entry.evidence, entry]));

  for (const [index, payment] of payments.entries()) {
    const key = evidence(payment);
    const group = groups.get(key) ?? [];
    group.push(index);
    groups.set(key, group);
  }

  // Resolve all strong matches before considering weaker competing candidates.
  const unresolved = new Map<string, number[]>();
  for (const [key, indices] of groups) {
    const exact = existingByEvidence.get(key) ?? [];
    const saved = memory.get(key);
    const targets = saved?.targets.map(target => {
      if (!target) return null;
      const found = existingById.get(target.id);
      if (!found) return undefined;
      const { row, key } = found;
      return (
        'source' in target
          ? key === target.source
          : row.date === target.date && row.amount === target.amount
      )
        ? row
        : undefined;
    });

    if (
      saved &&
      targets &&
      targets.length === indices.length &&
      targets.every(
        target => target !== undefined && (!target || !reserved.has(target.id)),
      ) &&
      exact.every(({ row }) => targets.some(target => target?.id === row.id))
    ) {
      for (const [i, index] of indices.entries()) {
        const target = targets[i];
        if (target) reserved.add(target.id);
        // Indistinguishable groups can be recognized as a whole without
        // rewriting a member's import metadata on an arbitrary UUID.
        assignments[index] = {
          match: target ?? null,
          skip: !target || target.tombstone === 1 || indices.length > 1,
        };
      }
    } else if (
      (!saved ||
        (indices.length > 1 && saved.targets.length !== indices.length)) &&
      exact.length === indices.length &&
      exact.every(({ row }) => !reserved.has(row.id))
    ) {
      for (const [i, index] of indices.entries()) {
        const { row } = exact[i];
        reserved.add(row.id);
        assignments[index] = {
          match: row,
          skip: row.tombstone === 1 || indices.length > 1,
        };
      }
    } else {
      unresolved.set(key, indices);
    }
  }

  for (const [key, indices] of unresolved) {
    for (const index of indices) {
      const payment = payments[index];
      const amount = amountToInteger(Number(payment.transactionAmount.amount));
      const candidates = (existingByAmount.get(amount) ?? []).filter(
        ({ row, source, key: candidateKey }) => {
          if (reserved.has(row.id)) return candidateKey === key;
          const sourceDate = source?.date ?? db.fromDateRepr(row.date);
          return (
            (!source ||
              source.transactionAmount.currency ===
                payment.transactionAmount.currency) &&
            (candidateKey === key ||
              (payment.transactionId &&
                payment.transactionId === row.imported_id) ||
              Math.abs(
                differenceInDays(parseISO(payment.date), parseISO(sourceDate)),
              ) <= 7)
          );
        },
      );

      if (!candidates.length && !memory.has(key)) continue;
      conflictEvidence.add(key);
      conflicts.push({
        index,
        date: payment.date,
        amount,
        payee: payment.payeeName,
        notes: payment.notes ?? payment.remittance_information?.join(' ') ?? '',
        currency: payment.transactionAmount.currency,
        candidates: candidates
          .filter(({ row }) => !reserved.has(row.id))
          .map(({ row }) => ({
            id: row.id,
            date: row.date,
            amount: row.amount,
            payee: row.payee_name || row.imported_payee || null,
            notes: row.notes ?? null,
            deleted: row.tombstone === 1,
            reconciled: row.reconciled === 1,
            split: row.is_parent === 1,
            transfer: row.transfer_id != null,
          })),
      });
    }
  }

  if (!conflicts.length && !resolution) return assignments;

  const review = { conflicts };
  const snapshot = uuidv5(
    JSON.stringify([
      review,
      assignments.map(({ match, skip }) => [match?.id ?? null, !!skip]),
    ]),
    uuidv5.URL,
  );
  if (!resolution || resolution.snapshot !== snapshot) {
    throw new EnableBankingReviewRequired(review, snapshot);
  }
  const choices = new Map(
    resolution.choices.map(choice => [choice.index, choice]),
  );
  if (
    choices.size !== conflicts.length ||
    choices.size !== resolution.choices.length
  ) {
    throw new Error('Choose one action for each conflicting transaction.');
  }

  for (const conflict of conflicts) {
    const choice = choices.get(conflict.index);
    if (!choice) throw new Error('A conflicting transaction has no decision.');
    switch (choice.action) {
      case 'match': {
        const candidate = conflict.candidates.find(
          row => row.id === choice.transactionId,
        );
        const match = rows.find(row => row.id === candidate?.id);
        if (!match || reserved.has(match.id)) {
          throw new Error(
            'The selected transaction is unavailable or already matched.',
          );
        }
        reserved.add(match.id);
        assignments[conflict.index] = { match, skip: match.tombstone === 1 };
        break;
      }
      case 'add':
        assignments[conflict.index] = {
          match: null,
          newId: resolution.makeId(),
        };
        break;
      case 'skip':
        assignments[conflict.index] = { match: null, skip: true };
        break;
      default:
        throw new Error('Invalid transaction decision.');
    }
  }
  const updatedMemory: Remembered[] = [];
  for (const key of conflictEvidence) {
    const indices = groups.get(key) ?? [];
    updatedMemory.push({
      evidence: key,
      targets: indices.map(index => {
        const { match, newId } = assignments[index];
        return match
          ? { id: match.id, date: match.date, amount: match.amount }
          : newId
            ? { id: newId, source: key }
            : null;
      }),
    });
  }
  resolution.remember(updatedMemory);
  return assignments;
}
