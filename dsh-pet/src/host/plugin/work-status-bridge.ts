/**
 * 工作状态联动：把 store 里的活动状态按 5s 间隔压扁后写进轮询快照。
 *
 * 不监听会话事件（归会话监听器），不渲染气泡。
 * 依赖由 apply 显式传入（见输入类型），模块内不读全局、不建单例。
 * @module dsh-pet/src/host/plugin/work-status-bridge
 */
import type { HostSetup } from './setup.ts';

/** 工作状态桥的输入：轮询快照、工作状态 store，以及判定「外部槽」用的哨兵会话 id。 */
export type WorkStatusBridgeInput = Pick<HostSetup, 'state' | 'workStatus' | 'EXTERNAL_WORK_SESSION'>;

/**
 * 创建工作状态桥。
 */
export function createWorkStatusBridge(deps: WorkStatusBridgeInput) {
  const { state, workStatus, EXTERNAL_WORK_SESSION } = deps;
  // 工作状态快照写进 S：内容真的变了才写（每次写都推进 counter，前端据此重播档位动画）。
  // 只压「距上次写入不足 WORK_STATE_GAP_MS 的 working → result」——工具秒回时会来回切十几次，
  // 每切一次前端就把片段从第 0 帧重播；反向不压（开工迟到比多换一次片更糟），终态不压。
  const WORK_STATE_GAP_MS = 5000;

  let publishedWork = '\u0000';

  let publishedState: string | null = null;

  let publishedWorkAt = 0;

  let workFlushTimer: ReturnType<typeof setTimeout> | null = null;

  const publishWorkStatus = (): void => {
    const snap = workStatus.snapshot();
    // 花费与会话都进签名：只改金额（同档位同文案）或换了会话时同样要写一拍，
    // 否则气泡停在旧金额上 / 点气泡跳到上一条会话。
    const key =
      String(snap.state) +
      '\u0000' +
      String(snap.task) +
      '\u0000' +
      String(snap.cost) +
      '\u0000' +
      String(snap.sessionId ?? '');
    if (key === publishedWork) return;
    // 抖动判定：只压 working → result 这一个方向（同档只换文案不算抖动，照常立即写；
    // 反向 result → working 立即写）
    const busyFlip = publishedState === 'working' && snap.state === 'result';
    const wait = WORK_STATE_GAP_MS - (Date.now() - publishedWorkAt);
    if (busyFlip && wait > 0) {
      // 整条不写（档位与文案一起压住）：到点再取最新快照补写
      // （不要在这里缓存 snap——期间可能又变了）
      workFlushTimer ??= setTimeout(() => {
        workFlushTimer = null;
        publishWorkStatus();
      }, wait);
      return;
    }
    if (workFlushTimer !== null) {
      clearTimeout(workFlushTimer);
      workFlushTimer = null;
    }
    publishedWork = key;
    publishedState = snap.state;
    publishedWorkAt = Date.now();
    // cost 缺省不写这个键：外部写入（POST /work-status）与没算出金额的终态都保持原有形状，
    // 消费端「键在不在」就是「这轮有没有金额」。
    // 外部槽（`api`）不是真实 DSH 会话：这里写成 null，客户端才不会把气泡做成一个点了没反应的入口。
    const sessionId = snap.sessionId === null || snap.sessionId === EXTERNAL_WORK_SESSION ? null : snap.sessionId;
    state.writeSection('workStatus', {
      state: snap.state,
      task: snap.task,
      sessionId,
      ...(snap.cost ? { cost: snap.cost } : {}),
    });
  };

  /** 上一次写出去的每轮花费快照（序列化后比对，内容没变不写）。 */
  let publishedTurnCosts = '';

  /**
   * 写每轮花费（sessionId → turn → `¥0.0021`）。
   *
   * 与工作状态分开成两个叶子：它只给对话界面在「用量」右侧补一句，宠物完全不读；混进
   * workStatus 会让宠物因为别人的轮次多写一拍。
   */
  const publishTurnCosts = (costs: Record<string, Record<string, string>>): void => {
    const key = JSON.stringify(costs);
    if (key === publishedTurnCosts) return;
    publishedTurnCosts = key;
    state.writeSection('turnCost', costs);
  };

  /** 停掉挂起的补写定时器（插件卸载时调用）。 */
  const stopWorkStatusFlush = (): void => {
    if (workFlushTimer !== null) {
      clearTimeout(workFlushTimer);
      workFlushTimer = null;
    }
  };
  return { publishWorkStatus, publishTurnCosts, stopWorkStatusFlush };
}
/** 工作状态桥的产出（供下游工厂按需 Pick）。 */
export type WorkStatusBridge = ReturnType<typeof createWorkStatusBridge>;
