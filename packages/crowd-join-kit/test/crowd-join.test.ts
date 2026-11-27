// @vitest-environment node
/**
 * 进场约束测试：1500 个人逐个进房间，一个观察者（对面）在线收每一拍。
 *
 * 约束（来自需求）：
 *  - 1500 拍，进一个发一拍，不是最后拼成一个整包；
 *  - 一串发完 < 180 毫秒；
 *  - 增量合计 < 400 000 字节；
 *  - 对面人数和画布上的点一起涨，发完必须有 1500 个点；
 *  - 第一个人 (120, 80) 分数 7，最后一个 (169, 80) 分数 7，中间的人
 *    横坐标按 120 + (i % 50)，不能少；
 *  - 只加人，已经在场的人不改坐标。
 */
import { performance } from "node:perf_hooks";
import { describe, it, expect, beforeAll, afterAll } from "vitest";

import {
  ClientState,
  LocalDriver,
  LocalPresence,
  matchMaker,
  Server,
} from "@colyseus/core";
import { WebSocketTransport } from "@colyseus/ws-transport";
import { Client as SDKClient, type Room as SDKRoom } from "@colyseus/sdk";

import { CrowdRoom, CROWD_SIZE, personAt, type CrowdState } from "../src/index.ts";

const PORT = 8567;
const ROOM_STATE_PATCH = 15; // Protocol.ROOM_STATE_PATCH
const PROTOCOL_CODE_MASK = 0x1f;

const MAX_MS = 180;
const MAX_BYTES = 400_000;

describe("crowd-join: 1500 人逐个进场", () => {
  let server: Server;
  let presence: LocalPresence;
  let driver: LocalDriver;

  beforeAll(async () => {
    presence = new LocalPresence();
    driver = new LocalDriver();
    server = new Server({
      greet: false,
      gracefullyShutdown: false,
      presence,
      driver,
      transport: new WebSocketTransport({
        // 不让 ping 混进测量窗口
        pingInterval: 60_000,
        pingMaxRetries: 1,
      }),
    });
    await matchMaker.setup(presence, driver);
    server.define("crowd", CrowdRoom);
    await server.listen(PORT);
  });

  afterAll(async () => {
    await server.gracefullyShutdown(false);
    await driver.shutdown();
  });

  it("1500 拍 < 180ms、增量 < 40 万字节、对面 1500 个点一个一个多起来", async () => {
    // 对面：观察者先进房间（场上 0 个人）
    const observer = await new SDKClient(`ws://localhost:${PORT}`).joinOrCreate<CrowdState>("crowd");

    // 在线上数拍：只数状态增量帧（ROOM_STATE_PATCH），初始全量不算拍
    let beats = 0;
    let beatBytes = 0;
    let maxBeat = 0;
    const ws: WebSocket = (observer.connection.transport as any).ws;
    ws.addEventListener("message", (event: any) => {
      const bytes = new Uint8Array(event.data);
      if ((bytes[0] & PROTOCOL_CODE_MASK) !== ROOM_STATE_PATCH) { return; }
      beats++;
      beatBytes += bytes.byteLength;
      if (bytes.byteLength > maxBeat) { maxBeat = bytes.byteLength; }
    });

    // 记录对面人数每一次变化：必须 0 -> 1 -> 2 -> ... 一个一个涨
    const growth: number[] = [];
    observer.onStateChange(() => growth.push(observer.state.people.size));

    const room = matchMaker.getLocalRoomById(observer.roomId) as CrowdRoom;
    await waitUntil(() => room.clients[0]?.state === ClientState.JOINED);
    await waitUntil(() => observer.state?.people !== undefined);

    // 1500 个人逐个进场，进一个发一拍
    const t0 = performance.now();
    for (let i = 0; i < CROWD_SIZE; i++) {
      room.enter(i);
    }
    const ms = performance.now() - t0;

    // 等所有拍在线上走完
    await waitUntil(() => observer.state.people.size === CROWD_SIZE && beats === CROWD_SIZE);

    // —— 拍数与节奏 ——
    expect(beats).toBe(CROWD_SIZE);                 // 一个人一拍，没多没少
    expect(ms).toBeLessThan(MAX_MS);                // 一串发完 < 180ms
    expect(beatBytes).toBeLessThan(MAX_BYTES);      // 增量合计 < 40 万字节
    expect(maxBeat).toBeLessThanOrEqual(64);        // 每一拍只装得下一个人

    // —— 对面的人数：一个一个涨，最后 1500 ——
    expect(growth[growth.length - 1]).toBe(CROWD_SIZE);
    for (let k = 1; k < growth.length; k++) {
      expect(growth[k] - growth[k - 1]).toBe(1); // 每拍恰好多一个，从不跳、不空
    }

    // —— 坐标和分数：第一个、最后一个、中间每一个 ——
    const people = observer.state.people;
    expect(people.size).toBe(CROWD_SIZE);
    for (let i = 0; i < CROWD_SIZE; i++) {
      const p = people.get(String(i));
      const want = personAt(i);
      expect(p, `第 ${i} 个人`).toBeDefined();
      expect(p!.x).toBe(want.x);
      expect(p!.y).toBe(want.y);
      expect(p!.score).toBe(want.score);
    }
    expect(people.get("0")!.x).toBe(120);           // 第一个点
    expect(people.get(String(CROWD_SIZE - 1))!.x).toBe(169); // 最后一个点

    console.log(
      `[crowd-join] ${CROWD_SIZE} 拍, ${ms.toFixed(1)}ms, ` +
      `增量 ${beatBytes} 字节 (最大单拍 ${maxBeat} 字节), 对面 ${people.size} 个点`,
    );

    await observer.leave();
  }, 30_000);
});

async function waitUntil(condition: () => boolean, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) { throw new Error("waitUntil 超时"); }
    await new Promise((r) => setTimeout(r, 5));
  }
}
