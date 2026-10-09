import { describe, expect, it } from 'vitest';
import { evaluatePolicy, type AutonomyLevel, type RiskClass } from '../src/tools/policy.js';

const risks: RiskClass[] = ['read_only', 'low_risk_write', 'consequential', 'destructive'];
const levels: AutonomyLevel[] = [0, 1, 2, 3];

describe('evaluatePolicy', () => {
  it('denies every tool at level 0', () => {
    for (const risk of risks) expect(evaluatePolicy(risk, 0)).toBe('deny');
  });

  it('allows reads, holds low-risk writes, and never auto-runs consequential or destructive actions', () => {
    expect(evaluatePolicy('read_only', 1)).toBe('allow');
    expect(evaluatePolicy('low_risk_write', 1)).toBe('require_approval');
    expect(evaluatePolicy('low_risk_write', 2)).toBe('allow');
    for (const level of levels.filter((level) => level > 0)) {
      expect(evaluatePolicy('consequential', level)).toBe('require_approval');
      expect(evaluatePolicy('destructive', level)).toBe('deny');
    }
  });
});
