import {
  resolveScienceExhibitContext,
  type ScienceExhibitAdapter,
  type ScienceExhibitSnapshot,
} from './science-exhibit-context';

function setup() {
  const current: ScienceExhibitSnapshot = {
    stateVersion: 4,
    state: { beta: 0.2, infected: 120 },
  };
  const loadCurrentImplementation: ScienceExhibitAdapter['loadCurrent'] = () =>
    Promise.resolve(current);
  const loadCurrent = jest.fn(loadCurrentImplementation);
  const recomputeImplementation: ScienceExhibitAdapter['recompute'] = ({
    current: before,
    requestedAction,
  }) => {
    if (requestedAction === null)
      return Promise.resolve({
        stateVersion: before.stateVersion,
        state: before.state,
        lastAction: null,
        displaySummary: 'Current server state.',
      });
    if (
      isRecord(requestedAction) &&
      requestedAction.type === 'change_parameter' &&
      requestedAction.name === 'beta' &&
      typeof requestedAction.value === 'number' &&
      isRecord(before.state)
    )
      return Promise.resolve({
        stateVersion: before.stateVersion + 1,
        state: { ...before.state, beta: requestedAction.value },
        lastAction: {
          type: 'change_parameter',
          name: 'beta',
          value: requestedAction.value,
        },
        displaySummary: 'Infected stock rises faster after beta increases.',
      });
    return Promise.resolve({ rejected: 'ACTION_NOT_ALLOWED' });
  };
  const recompute = jest.fn(recomputeImplementation);
  const adapter: ScienceExhibitAdapter = {
    exhibitId: 'science.sir.reasoning.v1',
    loadCurrent,
    recompute,
  };
  return { adapter, current, loadCurrent, recompute };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

const request = {
  exhibit_id: 'science.sir.reasoning.v1',
  state_version: 4,
  last_action: { type: 'change_parameter', name: 'beta', value: 0.3 },
  student_focus: 'Why did the curve change?',
};

describe('resolveScienceExhibitContext', () => {
  it('从服务端快照重算状态和摘要，不采用客户端状态字段', async () => {
    const { adapter, recompute } = setup();
    const result = await resolveScienceExhibitContext({
      candidate: request,
      adapter,
    });
    expect(result).toEqual({
      valid: true,
      context: {
        exhibit_id: 'science.sir.reasoning.v1',
        state_version: 5,
        state: { beta: 0.3, infected: 120 },
        last_action: { type: 'change_parameter', name: 'beta', value: 0.3 },
        display_summary: 'Infected stock rises faster after beta increases.',
        student_focus: 'Why did the curve change?',
      },
    });
    expect(recompute).toHaveBeenCalledWith({
      current: { stateVersion: 4, state: { beta: 0.2, infected: 120 } },
      requestedAction: request.last_action,
      studentFocus: request.student_focus,
    });
  });

  it('拒绝旧 state_version 且不调用状态 reducer', async () => {
    const { adapter, recompute } = setup();
    const result = await resolveScienceExhibitContext({
      candidate: { ...request, state_version: 3 },
      adapter,
    });
    expect(result).toEqual({
      valid: false,
      reason: 'STALE_STATE_VERSION',
      currentStateVersion: 4,
    });
    expect(recompute).not.toHaveBeenCalled();
  });

  it('拒绝客户端提供规范 state、display summary 或非 JSON action', async () => {
    const { adapter, loadCurrent } = setup();
    for (const candidate of [
      { ...request, state: { beta: 999 } },
      { ...request, display_summary: '客户端伪造摘要' },
      {
        ...request,
        last_action: { type: 'change_parameter', value: Number.NaN },
      },
      { ...request, last_action: new Proxy({ type: 'change_parameter' }, {}) },
    ])
      expect(
        await resolveScienceExhibitContext({ candidate, adapter }),
      ).toEqual({ valid: false, reason: 'INVALID_REQUEST' });
    expect(loadCurrent).not.toHaveBeenCalled();
  });

  it('拒绝未注册展品、未授权 action 与 reducer 输出状态版本篡改', async () => {
    const { adapter } = setup();
    expect(
      await resolveScienceExhibitContext({
        candidate: { ...request, exhibit_id: 'other' },
        adapter,
      }),
    ).toEqual({ valid: false, reason: 'WRONG_EXHIBIT' });
    expect(
      await resolveScienceExhibitContext({
        candidate: { ...request, last_action: { type: 'delete_course' } },
        adapter,
      }),
    ).toEqual({
      valid: false,
      reason: 'ACTION_REJECTED',
      detail: 'ACTION_NOT_ALLOWED',
    });
    jest.spyOn(adapter, 'recompute').mockResolvedValue({
      stateVersion: 6,
      state: { beta: 0.3 },
      lastAction: request.last_action,
      displaySummary: 'stale version jump',
    });
    expect(
      await resolveScienceExhibitContext({ candidate: request, adapter }),
    ).toEqual({ valid: false, reason: 'INVALID_RECOMPUTED_STATE' });
  });

  it('无动作读取不得悄悄改变服务端状态', async () => {
    const { adapter } = setup();
    jest.spyOn(adapter, 'recompute').mockResolvedValue({
      stateVersion: 4,
      state: { beta: 0.9, infected: 120 },
      lastAction: null,
      displaySummary: 'changed without action',
    });
    expect(
      await resolveScienceExhibitContext({
        candidate: { ...request, last_action: null },
        adapter,
      }),
    ).toEqual({ valid: false, reason: 'INVALID_RECOMPUTED_STATE' });
  });
});
