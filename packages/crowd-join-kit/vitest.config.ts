import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    // forks 池的子进程自带 process.send，@pm2/io（Stats.reset 动态导入）
    // 会把它当成 PM2 的 IPC 通道发 axm 消息，撞坏 vitest 的 IPC。
    // threads 池的 worker 里没有 process.send，@pm2/io 保持安静。
    pool: "threads",
  },
});
