import type { Env, EventRecord, Plan, PlanRequest } from '../types';
import { generateRulePlan } from './rule-based';
import { generateAiPlan } from './ai';

/**
 * プラン生成のエントリポイント。
 * engine='ai' かつ Workers AI が利用可能なときだけ AI を使い、
 * それ以外（標準）は完全無料・キー不要のルールベースで生成する。
 */
export async function generatePlan(
  env: Env,
  events: EventRecord[],
  req: PlanRequest,
): Promise<Plan> {
  if (req.engine === 'ai') {
    return generateAiPlan(env, events, req);
  }
  return generateRulePlan(events, req);
}
