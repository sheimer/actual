export async function fetchByIds<T>(
  ids: string[],
  fetchPage: (filter: string, ids: string[]) => Promise<T[]>,
): Promise<T[]> {
  const uniqueIds = [...new Set(ids)];
  const results: T[] = [];
  for (let offset = 0; offset < uniqueIds.length; offset += 500) {
    const page = uniqueIds.slice(offset, offset + 500);
    results.push(...(await fetchPage(page.map(() => '?').join(', '), page)));
  }
  return results;
}

export function whereIn(ids: string[], field: string) {
  const ids2 = [...new Set(ids)];

  const filter = `${field} IN (` + ids2.map(id => `'${id}'`).join(',') + ')';
  return filter;
}
