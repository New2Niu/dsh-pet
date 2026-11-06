/**
 * 「吃白饭」的动画槽位：把 `animations.baifan` 的 5 个名字按玩法契约摆好。
 *
 * 槽位顺序是玩法契约：跑向底部 / 追饭侧身跑 / 期待 / 吃碗饭 / 吃饭团。
 * 这里**只留名字、不拼地址**：点播走 `name` 形态（与右键「动作」同一条路），素材地址由渲染端
 * 按它自己的素材根与扩展名拼（见 ./pet/animation/assets 的 animationAssetUrl）。
 * 不能拼绝对地址——宿主 url 形态只收 http(s)，而桌面版页面的 origin 是 `dsh-app://`，
 * 那样的地址会被判 bad-request，演出根本起不来。
 * @module dsh-pet/src/client/baifan/assets
 */

/** 一场演出要用的五段动画名。 */
export interface ActivityAssets {
  /** 跑向屏幕底部（一次性）。 */
  descend: string;
  /** 追饭时的侧身跑（循环）。 */
  chase: string;
  /** 到位后等开饭（一次性）。 */
  expect: string;
  /** 吃到碗饭。 */
  eatBowl: string;
  /** 吃饭团。 */
  eatBall: string;
}

/**
 * 按槽位取五段动画名。
 *
 * @param names - `animations.baifan` 的 5 个动画名（顺序即槽位）；缺槽位按空串处理，
 *   点播会以 `unknown-animation` 显式失败，而不是拿错段去播。
 * @returns 五段动画名。
 */
export function activityAssets(names: readonly string[]): ActivityAssets {
  const at = (index: number): string => names[index] ?? '';
  return {
    descend: at(0),
    chase: at(1),
    expect: at(2),
    eatBowl: at(3),
    eatBall: at(4),
  };
}
