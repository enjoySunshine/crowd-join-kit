/**
 * 进场基准：1500 个人逐个进房间，一个观察者（对面）在线收每一拍。
 *
 * 用法：
 *   pnpm bench          # delta 模式 —— 每一拍只发新来的那一个（kit 的做法）
 *   pnpm bench -- --full   # full 模式 —— 每一拍把已经在场的人全部重发一遍（反例）
 *
 * 两种模式量同一串东西：1500 拍的发送耗时、发到线上的增量字节合计，
 * 以及对面解出来的人数和坐标。
 */
import { performance } from "node:perf_hooks";

import {
  ClientState,
  LocalDriver,
  LocalPresence,
  matchMaker,
  Room,
  Server,
} from "@colyseus/core";
import { WebSocketTransport } from "@colyseus/ws-transport";
import { Client as SDKClient } from "@colyseus/sdk";

import { CrowdRoom, CrowdState, CROWD_SIZE, Person, personAt } from "../src/index.ts";

const MODE = process.argv.includes("--full") ? "full" : "delta";
const PORT = 8570;

/**
 * 反例：每一拍把已经在场的人全部重发一遍。
 * 第 k 拍发 k 个人，1500 拍是三角数 —— 这就是 24MB / 秒级耗时的来历。
 */
class FullStateCrowdRoom extends Room {
  state = new CrowdState();

  onCreate() {
    this.patchRate = 0;
  }

  enter(i: number) {
    const spot = personAt(i);
    const person = new Person();
    person.x = spot.x;
    person.y = spot.y;
    person.score = spot.score;
    this.state.people.set(String(i), person);

    // 重发全场：每个在场的客户端都再收一遍所有人
    for (const client of this.clients) {
      if (client.state === ClientState.JOINED) {
        (this as any).sendFullState(client);
      }
    }
  }
}

async function main() {
  const presence = new LocalPresence();
  const driver = new LocalDriver();
  const server = new Server({
    greet: false,
    gracefullyShutdown: false,
    presence,
    driver,
    transport: new WebSocketTransport({ pingInterval: 60_000, pingMaxRetries: 1 }),
  });
  await matchMaker.setup(presence, driver);
  server.define("crowd", MODE === "full" ? FullStateCrowdRoom : CrowdRoom);
  await server.listen(PORT);

  // 对面：观察者先进房间（场上 0 个人）
  const observer = await new SDKClient(`ws://localhost:${PORT}`).joinOrCreate<CrowdState>("crowd");
  const room = matchMaker.getLocalRoomById(observer.roomId)!;
  await waitUntil(() => room.clients[0]?.state === ClientState.JOINED);
  await waitUntil(() => observer.state?.people !== undefined);

  // 发送侧计数：服务器递交给传输层的每一帧（初始全量之后的才算拍）
  const serverClient: any = room.clients[0];
  const origRaw = serverClient.raw.bind(serverClient);
  let sentBytes = 0;
  let sentFrames = 0;
  let maxFrame = 0;
  serverClient.raw = (data: Uint8Array, options?: unknown) => {
    sentFrames++;
    sentBytes += data.byteLength;
    if (data.byteLength > maxFrame) { maxFrame = data.byteLength; }
    return origRaw(data, options);
  };

  // 接收侧计数：对面在线上实际收到的增量帧
  let recvBytes = 0;
  let recvFrames = 0;
  const ws: WebSocket = (observer.connection.transport as any).ws;
  ws.addEventListener("message", (event: any) => {
    const bytes = new Uint8Array(event.data);
    recvFrames++;
    recvBytes += bytes.byteLength;
  });

  // 1500 个人逐个进场，进一个发一拍
  const t0 = performance.now();
  for (let i = 0; i < CROWD_SIZE; i++) {
    (room as CrowdRoom).enter(i);
  }
  const ms = performance.now() - t0;

  // 等线上走完（full 模式 24MB 在回环上也要排一会儿队）
  await waitUntil(() => recvFrames >= sentFrames, 60_000);

  const people = observer.state.people;
  const first = people.get("0");
  const last = people.get(String(CROWD_SIZE - 1));
  let allCorrect = people.size === CROWD_SIZE;
  for (let i = 0; i < CROWD_SIZE && allCorrect; i++) {
    const p = people.get(String(i));
    const want = personAt(i);
    allCorrect = !!p && p.x === want.x && p.y === want.y && p.score === want.score;
  }

  console.log(`模式:            ${MODE === "full" ? "full（每拍重发全场，反例）" : "delta（每拍只发新来的那一个）"}`);
  console.log(`拍数:            ${sentFrames}`);
  console.log(`发送耗时:        ${ms.toFixed(1)} ms${MODE === "delta" ? "   （要求 < 180）" : ""}`);
  console.log(`增量合计:        ${sentBytes} 字节${MODE === "delta" ? "   （要求 < 400 000）" : ""}`);
  console.log(`最大单拍:        ${maxFrame} 字节`);
  console.log(`对面收到:        ${recvFrames} 帧 / ${recvBytes} 字节`);
  console.log(`对面人数:        ${people.size}`);
  console.log(`第一个人:        x=${first?.x} y=${first?.y} score=${first?.score}`);
  console.log(`最后一个人:      x=${last?.x} y=${last?.y} score=${last?.score}`);
  console.log(`中间的人全部正确: ${allCorrect}`);

  if (MODE === "delta") {
    const pass = ms < 180 && sentBytes < 400_000 && allCorrect && sentFrames === CROWD_SIZE;
    console.log(`\n约束检查: ${pass ? "通过" : "未通过"}（< 180ms、< 40 万字节、1500 个点全对）`);
  }

  await observer.leave();
  await server.gracefullyShutdown(false);
  await driver.shutdown();
  process.exit(0);
}

async function waitUntil(condition: () => boolean, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) { throw new Error("waitUntil 超时"); }
    await new Promise((r) => setTimeout(r, 5));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
