import type { Env, EventRecord, Plan, PlanRequest } from '../types';
import { generateRulePlan } from './rule-based';
import { generateAiPlan } from './ai';

/**
 * プラン生成のエントリポイント。
 * Workers AI が使えるなら、理由・楽しみ方つきの提案プランを既定で生成する
 * （engine='rule' が明示されたときだけルールベース）。AI失敗時も内部で
 * ルールベースにフォールバックする。
 */
export async function generatePlan(
  env: Env,
  events: EventRecord[],
  req: PlanRequest,
): Promise<Plan> {
  if (req.engine !== 'rule' && env.AI) {
    return generateAiPlan(env, events, req);
  }
  return generateRulePlan(events, req);
}
