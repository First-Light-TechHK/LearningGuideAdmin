import { describeAgentEventLog } from './agent-event-log.conformance-spec';
import {
  createMemoryAgentEventLog,
  PrismaAgentEventLog,
} from './agent-event.store';

describeAgentEventLog('memory log', () => createMemoryAgentEventLog());

describe('agent event log has no rewrite path', () => {
  it('offers append, read, chain and the 90-day learner-text purge only', () => {
    const methods = (proto: object) =>
      Object.getOwnPropertyNames(proto)
        .filter((name) => name !== 'constructor')
        .sort();
    expect(methods(PrismaAgentEventLog.prototype)).toEqual([
      'append',
      'chain',
      'purgeLearnerText',
      'read',
    ]);
    expect(Object.keys(createMemoryAgentEventLog()).sort()).toEqual([
      'append',
      'chain',
      'purgeLearnerText',
      'read',
      'runs',
    ]);
  });
});
