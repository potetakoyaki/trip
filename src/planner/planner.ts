import type { Env, EventRecord, HotelOption, Plan, PlanRequest } from '../types';
import { generateRulePlan } from './rule-based';
import { generateAiPlan } from './ai';

export interface PlanOptions {
  /** 実在ホテル（楽天等）。あれば AI 概算より優先する。 */
  hotels?: HotelOption[];
}

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
  opts: PlanOptions = {},
): Promise<Plan> {
  const plan =
    req.engine !== 'rule' && env.AI
      ? await generateAiPlan(env, events, req, opts)
      : generateRulePlan(events, req);
  // AIプランが内部でルールベースに退避した場合でも実ホテルが消えないよう補完する。
  if (opts.hotels?.length && (!plan.hotels || plan.hotels.length === 0)) {
    plan.hotels = opts.hotels;
  }
  return plan;
}
