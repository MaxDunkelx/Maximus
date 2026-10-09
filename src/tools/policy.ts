export type RiskClass = 'read_only' | 'low_risk_write' | 'consequential' | 'destructive';
export type AutonomyLevel = 0 | 1 | 2 | 3;
export type PolicyDecision = 'allow' | 'require_approval' | 'deny';

/**
 * Application-enforced permission policy.
 * Level 3 does not bypass consequential or destructive checks.
 * Explicit preauthorization grants are not implemented yet, so those actions stay gated.
 */
export function evaluatePolicy(risk: RiskClass, autonomy: AutonomyLevel): PolicyDecision {
  if (autonomy <= 0) return 'deny';
  switch (risk) {
    case 'read_only':
      return 'allow';
    case 'low_risk_write':
      return autonomy === 1 ? 'require_approval' : 'allow';
    case 'consequential':
      return 'require_approval';
    case 'destructive':
      return 'deny';
    default:
      return 'deny';
  }
}
