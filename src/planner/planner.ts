import type { Env, EventRecord, HotelOption, Plan, PlanRequest } from '../types';
import { generateRulePlan } from './rule-based';
import { generateAiPlan, AiQuotaError } from './ai';
import { geminiEnabled } from './gemini';

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
  let plan: Plan;
  if (req.engine !== 'rule' && (env.AI || geminiEnabled(env))) {
    try {
      plan = await generateAiPlan(env, events, req, opts);
    } catch (e) {
      // AIの無料枠（ニューロン）切れ等でAIが使えないときは、エラーで全滅させず、
      // 収集済みスポットからルールベースの簡易プランを作って返す。
      if (e instanceof AiQuotaError) {
        plan = generateRulePlan(events, req);
        plan.notice =
          'AIの本日の無料枠（ニューロン）が上限に達したため、収集済みスポットから簡易プランを作成しました。AIによる選定理由・楽しみ方の解説は省略しています。無料枠はUTC0時にリセットされます。';
      } else {
        throw e;
      }
    }
  } else {
    plan = generateRulePlan(events, req);
  }
  // AIプランが内部でルールベースに退避した場合でも実ホテルが消えないよう補完する。
  if (opts.hotels?.length && (!plan.hotels || plan.hotels.length === 0)) {
    plan.hotels = opts.hotels;
  }
  return plan;
}
