/**
 * 全局开关卡：通知、点击音效、锁定在当前屏幕、系统托盘，外加气泡停留时长（数字）。
 * 切换与改数字都只改本地状态，随「保存」整包写入——即时写盘会重启桌面 Helper、重建全部桌面宠物窗口。
 * 通知开关额外需要用户手势，开与关都要走外壳的同一个入口，因此卡里只回传键名与目标值。
 * @module dsh-pet/src/client/settings/global-card
 */
import type { FunctionComponent } from 'react';
import { BUBBLE_DURATION_SEC_MAX, BUBBLE_DURATION_SEC_MIN } from '../../shared/config.ts';
import type { SettingsRuntime } from './runtime.ts';
import { makeUiKit, numberInputProps } from './ui.ts';

/** 四个全局开关的键名，与成品配置的字段名一致。 */
export type GlobalFlagKey = 'notificationsEnabled' | 'clickSoundEnabled' | 'confineToScreen' | 'trayEnabled';

/** 四个全局开关的当前值。 */
export type GlobalFlags = Record<GlobalFlagKey, boolean>;

/** 全局开关卡的输入。 */
export interface GlobalCardProps {
  /** 保存中或配置未就绪时禁用全部控件。 */
  busy: boolean;
  /** 当前值。 */
  values: GlobalFlags;
  /** 某个开关被切换；通知开关的权限申请由外壳处理。 */
  onChange: (key: GlobalFlagKey, value: boolean) => void;
  /** 气泡停留时长（秒）：碎碎念 / 对话 / 余额 / 任务提示共用。 */
  bubbleDurationSec: number;
  /** 改气泡停留时长（秒）；区间校验在宿主，这里只保证输入框的上下限。 */
  onBubbleDurationChange: (value: number) => void;
}

/** 开关的展示顺序与文案键。 */
const TOGGLES: Array<{ key: GlobalFlagKey; label: string }> = [
  { key: 'notificationsEnabled', label: 'notifyToggle' },
  { key: 'clickSoundEnabled', label: 'clickSoundToggle' },
  { key: 'confineToScreen', label: 'confineToggle' },
  { key: 'trayEnabled', label: 'trayToggle' },
];

/**
 * 造全局开关卡。
 *
 * @param rt - 注入的 react 能力与翻译函数。
 * @returns 卡片组件。
 */
export function makeGlobalCard(rt: SettingsRuntime): FunctionComponent<GlobalCardProps> {
  const { h, t } = rt;
  const { cardHead, field, toggleCell } = makeUiKit({ h, t });

  return function GlobalCard(props: GlobalCardProps) {
    // 数字框失焦提交：空串/脏值由 numberInputProps 丢掉，回到生效值。
    const durationInput = h(
      'input',
      numberInputProps(props.bubbleDurationSec, props.onBubbleDurationChange, {
        step: '1',
        min: String(BUBBLE_DURATION_SEC_MIN),
        max: String(BUBBLE_DURATION_SEC_MAX),
        disabled: props.busy,
      }),
    );

    return h('div', {
      className: 'dsh-pet-cfg__card',
      children: [
        cardHead(t('globalTitle'), t('globalHint')),
        h('div', {
          className: 'dsh-pet-cfg__grid4',
          children: TOGGLES.map((toggle) =>
            toggleCell(toggle.label, props.values[toggle.key], props.busy, (value) =>
              props.onChange(toggle.key, value),
            ),
          ),
        }),
        // 停留下方单独一行：它是个数值而不是开关，混进上面那排勾选框会让人以为能打勾。
        h('div', {
          className: 'dsh-pet-cfg__grid4',
          children: [field(t('bubbleDuration'), durationInput, t('bubbleDurationHint'))],
        }),
      ],
    });
  };
}
