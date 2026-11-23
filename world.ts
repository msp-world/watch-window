/**
 * 通用桌面窗口盯屏分镜流 MSP World（移植自 cortico-world-watch-window）：
 * - 工具：watch_window_pick, watch_window_stop, watch_window_look
 * - 信号：watch.frame, watch.stopped
 */
import { ToolResult, imageContent, type MSPNode } from "../shared/msp.ts";

export interface WindowEntry {
  id: string;
  title: string;
  process: string;
  width: number;
  height: number;
  foreground: boolean;
}

export interface WatchWindowAdapter {
  listWindows(): Promise<WindowEntry[]>;
  captureWindow(id: string, region?: { x: number; y: number; width: number; height: number }): Promise<{ mime: string; base64: string }>;
}

export class WatchWindowWorld {
  private readonly adapter: WatchWindowAdapter;
  private readonly intervalMs: number;
  private node: MSPNode | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private watching: WindowEntry | null = null;

  constructor(adapter: WatchWindowAdapter, intervalMs = 5000) {
    this.adapter = adapter;
    this.intervalMs = intervalMs;
  }

  attach(node: MSPNode): void {
    this.node = node;
    node.declareSignal("watch.frame", "盯屏窗口定时观察帧");
    node.declareSignal("watch.stopped", "停止盯屏");

    node.tool(
      "watch_window_pick",
      "列出可观察窗口，或按编号/标题关键字/front 选定一个窗口开始盯屏",
      async (args) => {
        const list = await this.adapter.listWindows();
        const target = typeof args.target === "string" ? args.target.trim() : "";
        if (!target) return { windows: list };

        const picked =
          target.toLowerCase() === "front"
            ? list.find((w) => w.foreground) ?? list[0]
            : list.find(
                (w) =>
                  w.id === target ||
                  w.title.toLowerCase().includes(target.toLowerCase()) ||
                  w.process.toLowerCase().includes(target.toLowerCase()),
              );
        if (!picked) throw new Error(`未找到匹配窗口: ${target}`);
        this.watching = picked;
        this.startLoop();
        return { watching: picked };
      },
      { type: "object", properties: { target: { type: "string" } } },
    );

    node.tool(
      "watch_window_stop",
      "停止当前窗口盯屏",
      () => {
        this.stop();
        this.watching = null;
        this.node?.publish("watch.stopped", {});
        return { stopped: true };
      },
      { type: "object", additionalProperties: false, properties: {} },
    );

    node.tool(
      "watch_window_look",
      "立即截取当前盯屏窗口的一张高清画面（支持 0-1 比例局部放大）",
      async (args) => {
        if (!this.watching) throw new Error("当前未选定任何盯屏窗口，请先调用 watch_window_pick");
        const region =
          typeof args.x === "number" && typeof args.y === "number" && typeof args.width === "number" && typeof args.height === "number"
            ? { x: args.x, y: args.y, width: args.width, height: args.height }
            : undefined;
        const shot = await this.adapter.captureWindow(this.watching.id, region);
        return new ToolResult([imageContent(shot.base64, shot.mime)], {
          window: this.watching,
          mime: shot.mime,
        });
      },
      {
        type: "object",
        properties: {
          x: { type: "number", minimum: 0, maximum: 1 },
          y: { type: "number", minimum: 0, maximum: 1 },
          width: { type: "number", minimum: 0.05, maximum: 1 },
          height: { type: "number", minimum: 0.05, maximum: 1 },
        },
      },
    );

    node.skill({
      name: "watch_lifecycle",
      summary: "先无参列出窗口，再选定目标盯屏与按需抓高清局部，结束后停止盯屏",
      whenToUse: "需要观察无官方 API 的任意桌面游戏或应用窗口时使用",
      toolsUsed: ["watch_window_pick", "watch_window_look", "watch_window_stop"],
    });
  }

  private startLoop(): void {
    this.stop();
    if (this.intervalMs <= 0) return;
    this.timer = setInterval(() => void this.emitFrame(), this.intervalMs);
    this.timer.unref?.();
  }

  async emitFrame(): Promise<void> {
    if (!this.watching || !this.node) return;
    try {
      const shot = await this.adapter.captureWindow(this.watching.id);
      this.node.publish("watch.frame", { window: this.watching, mime: shot.mime, base64: shot.base64 });
    } catch {
      /* ignore transient capture error */
    }
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
