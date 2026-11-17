import { employeeNames, operatorName } from './employee-names';

function fakeDb(rows: Array<{ employeeId: string; loginEmail: string }>) {
  const findMany = jest.fn(
    ({ where }: { where: { employeeId: { in: string[] } } }) =>
      Promise.resolve(
        rows.filter((row) => where.employeeId.in.includes(row.employeeId)),
      ),
  );
  return { db: { employee: { findMany } }, findMany };
}

describe('employee names', () => {
  it('uses the part of the login e-mail before the @', async () => {
    const { db } = fakeDb([
      { employeeId: 'e1', loginEmail: 'anna.li@example.org' },
    ]);
    const names = await employeeNames(db, ['e1']);
    expect(operatorName(names, 'e1')).toBe('anna.li');
  });

  it('reads System for a missing actor and never queries for it', async () => {
    const { db, findMany } = fakeDb([]);
    const names = await employeeNames(db, [null, undefined]);
    expect(findMany).not.toHaveBeenCalled();
    expect(operatorName(names, null)).toBe('System');
    expect(operatorName(names, undefined)).toBe('System');
  });

  it('asks the database once for a repeated id', async () => {
    const { db, findMany } = fakeDb([
      { employeeId: 'e1', loginEmail: 'a@x.org' },
    ]);
    await employeeNames(db, ['e1', 'e1', null, 'e1']);
    expect(findMany).toHaveBeenCalledTimes(1);
    expect(findMany.mock.calls[0][0].where.employeeId.in).toEqual(['e1']);
  });

  it('falls back to the id itself when the employee row is gone', async () => {
    const { db } = fakeDb([]);
    const names = await employeeNames(db, ['gone']);
    expect(operatorName(names, 'gone')).toBe('gone');
  });
});
