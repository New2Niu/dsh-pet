/**
 * 共享层：把宿主半侧的成品配置拍平成渲染用宠物列表。
 * 不负责读取、合并与校验——那是宿主半侧 readAllConfig 的职责，本层只消费其结果。
 * 不依赖 React / DOM；宿主半侧不 import 本目录，其配置实现自包含、规则须与本层同步。
 * 条目级字段必须吹进每只实例：多实例共享所属条目的同一份值。
 * @module dsh-pet/src/shared/config
 */
import type { Animations, FontConfig, ModelSelection, Pet, PetDisplay, PhysicsParams, Weights } from './types.ts';

/** 显示位置白名单。 */
export const PET_DISPLAYS: PetDisplay[] = ['web', 'desktop', 'both', 'none'];

/**
 * 气泡弹出后的默认停留时长（秒）：config.jsonc 的 `bubbleDurationSec` 的缺省值。
 *
 * 两端兜底同源——浏览器的三个气泡计时器与桌面 Helper 的四个计时器在配置读不到时都取它，
 * 不各写一份数字（写两份必然有一天对不上）。
 */
export const DEFAULT_BUBBLE_DURATION_SEC = 5;

/** `bubbleDurationSec` 的合法区间（整秒）。
 *  下限 1 秒：0 会让「弹出」等于「立刻收起」，与接口的 duration = 0（不显示）撞成同一件事；
 *  上限 1 小时：够长到近似常驻，又离 setTimeout 的最大延迟差着量级。 */
export const BUBBLE_DURATION_SEC_MIN = 1;
export const BUBBLE_DURATION_SEC_MAX = 3600;

/**
 * 该值能否作为 `bubbleDurationSec`：整秒且落在区间内。
 *
 * 认字符串数字（`"15"`）与别处读接口的口径一致——手写 JSONC 时写成带引号不该整段判非法。
 *
 * @param value - 配置里的原值。
 * @returns 合法则 true。
 */
export function isValidBubbleDurationSec(value: unknown): boolean {
  if (typeof value !== 'number' && typeof value !== 'string') return false;
  const n = Number(value);
  return Number.isInteger(n) && n >= BUBBLE_DURATION_SEC_MIN && n <= BUBBLE_DURATION_SEC_MAX;
}

/**
 * 秒 → 毫秒，缺省 / 非法回落 {@link DEFAULT_BUBBLE_DURATION_SEC}。
 *
 * 消费端只调这一个函数，不各自写「先取值再判范围」——落一个漏判就是永不收起的气泡。
 *
 * @param sec - 配置里的 `bubbleDurationSec`。
 * @returns 正数毫秒，可直接喂给 setTimeout。
 */
export function bubbleDurationMs(sec: unknown): number {
  return (isValidBubbleDurationSec(sec) ? Number(sec) : DEFAULT_BUBBLE_DURATION_SEC) * 1000;
}

/** 该宠物是否参与浏览器半侧渲染。 */
export const isWebVisible = (display: PetDisplay): boolean => display === 'web' || display === 'both';

/** 该宠物是否参与桌面模式（Electron 透明窗）渲染。 */
export const isDesktopVisible = (display: PetDisplay): boolean => display === 'desktop' || display === 'both';

/** 把成品聚合拍平成渲染用宠物列表。
 *  条目级字段（animations / physics / font 等）由所属条目一份、多实例共享；assetRoot 取条目 key，
 *  即素材根。非 main 条目打 extra 标记：文件宠物在设置页不可编辑、保存时排除。 */
export function flattenConfigPets(merged: Record<string, Record<string, unknown>>): Pet[] {
  const out: Pet[] = [];
  for (const [entry, conf] of Object.entries(merged)) {
    const list = Array.isArray(conf?.pets) ? (conf.pets as Pet[]) : [];
    for (const p of list) {
      out.push({
        ...p,
        animations: conf.animations as Animations | undefined,
        animationWeights: conf.animationWeights as Weights | undefined,
        eventsRefreshSec: conf.eventsRefreshSec as Record<string, number> | undefined,
        physics: conf.physics as PhysicsParams | undefined,
        font: conf.font as FontConfig | undefined,
        confineToScreen: conf.confineToScreen as boolean | undefined,
        workStatusTexts: conf.workStatusTexts as string[][] | undefined,
        // 睡觉文案：渲染端要能「睡着时点对话/碎碎念就弹拒绝台词」，所以必须在拍平时带出来
        // （与 workStatusTexts 同一类条目级字段：多实例共享所属条目那一份）。
        sleepStartTexts: conf.sleepStartTexts as string[] | undefined,
        sleepEndTexts: conf.sleepEndTexts as string[] | undefined,
        sleepRefuseTexts: conf.sleepRefuseTexts as string[] | undefined,
        whisperModel: conf.whisperModel as ModelSelection | undefined,
        chatModel: conf.chatModel as ModelSelection | undefined,
        // 气泡停留时长（条目级）：渲染端三个计时器都读它；缺省/非法由 bubbleDurationMs 兜到默认。
        bubbleDurationSec: conf.bubbleDurationSec as number | undefined,
        // 表情包三件套：右键「配图」菜单要按配置里的清单与顺序分组，客户端不读磁盘，
        // 所以只能在拍平时一并带出；文件是否存在由宿主在生成时校验（见 host/memes 的池判定）。
        memes: conf.memes as Record<string, string> | undefined,
        chatImageEnabled: conf.chatImageEnabled as boolean | undefined,
        chatAnimationEnabled: conf.chatAnimationEnabled as boolean | undefined,
        chatImageLimit: conf.chatImageLimit as number | undefined,
        assetRoot: entry,
        extra: entry !== 'main',
      });
    }
  }
  return out;
}
