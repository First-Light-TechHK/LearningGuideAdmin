import { evaluateWeimarAppointmentGate } from './weimar-appointment-gate';

const qualifyingState = {
  presidentialAppointmentPower: true,
  presidentialAppointmentWillingness: 3,
  parliamentaryCapacity: 1,
  presidentialReliance: 2,
  eliteAccommodation: 1,
  naziPoliticalLeverage: 1,
};

describe('evaluateWeimarAppointmentGate', () => {
  it('reproduces the modeled pathway only when all six W14 conditions hold', () => {
    expect(evaluateWeimarAppointmentGate(qualifyingState)).toEqual({
      valid: true,
      eventId: 'E15',
      ruleId: 'W14',
      outcome: 'pathway_reproduced',
      conditions: {
        presidentialAppointmentPower: true,
        presidentialAppointmentWillingness: true,
        parliamentaryCapacity: true,
        presidentialReliance: true,
        eliteAccommodation: true,
        naziPoliticalLeverage: true,
      },
    });
  });

  it.each([
    ['presidentialAppointmentPower', false],
    ['presidentialAppointmentWillingness', 2],
    ['parliamentaryCapacity', 2],
    ['presidentialReliance', 1],
    ['eliteAccommodation', 0],
    ['naziPoliticalLeverage', 0],
  ] as const)(
    'blocks the modeled pathway when %s does not meet its condition',
    (key, value) => {
      const result = evaluateWeimarAppointmentGate({
        ...qualifyingState,
        [key]: value,
      });
      expect(result.valid).toBe(true);
      if (result.valid) expect(result.outcome).toBe('pathway_not_reproduced');
    },
  );

  it('rejects invalid ordinal values and client-added outcome fields', () => {
    for (const candidate of [
      { ...qualifyingState, parliamentaryCapacity: 5 },
      { ...qualifyingState, eliteAccommodation: 1.5 },
      { ...qualifyingState, naziPoliticalLeverage: Number.NaN },
      { ...qualifyingState, probability: 0.8 },
      new Proxy(qualifyingState, {}),
    ])
      expect(evaluateWeimarAppointmentGate(candidate)).toEqual({
        valid: false,
        reason: 'INVALID_STATE',
      });
  });
});
