import { Room } from "@colyseus/core";
import { schema, t, type SchemaType } from "@colyseus/schema";

/**
 * 场上的一个人：一个坐标 + 一个分数。
 * `number` 在 schema 里是 f64；这里 x 只取 120..169 的整数、y 恒为 80、
 * 分数恒为 7，规则见 {@link personAt}。
 */
export const Person = schema({
  x: t.number(),
  y: t.number(),
  score: t.number(),
});
export type Person = SchemaType<typeof Person>;

export const CrowdState = schema({
  people: t.map(Person),
});
export type CrowdState = SchemaType<typeof CrowdState>;

/** 进场总人数。 */
export const CROWD_SIZE = 1500;

/**
 * 第 i 个人的站位和分数：
 * 横坐标 120 + (i % 50)（在 120..169 之间循环），纵坐标 80，分数 7。
 * 第一个人（i=0）在 (120, 80)，最后一个（i=1499）在 (169, 80)。
 */
export function personAt(i: number): { x: number; y: number; score: number } {
  return { x: 120 + (i % 50), y: 80, score: 7 };
}

/**
 * 进场房间。
 *
 * 人一个一个进，进一个就发一拍。每一拍是**增量**：包里只有新来的
 * 这一个人；已经在场的人不重发、也不动。对面（客户端）把每一拍
 * 增量应用到本地状态上，画布上的点跟着一个一个多起来。
 *
 * 反例（不要这么做）：每一拍把已经在场的人全部重发一遍。第 k 拍
 * 就要发 k 个人，1500 拍合计是三角数 —— 约 2400 万字节、秒级耗时，
 * 见 `bench/crowd-join.ts` 的 `--full` 模式。
 */
export class CrowdRoom extends Room {
  state = new CrowdState();

  /** 已经进场的人数。 */
  public entered = 0;

  onCreate() {
    // 进场由 enter() 逐人驱动：进一个，发一拍。
    // 不定 patchRate —— 定时器会把先后进场的几个人合并进一拍，
    // 对面就不是一个一个看到人出现了。
    this.patchRate = 0;
  }

  /**
   * 第 i 个人进场：站到自己的位置上，立刻发一拍。
   * 返回刚进场的人。
   */
  public enter(i: number): Person {
    const spot = personAt(i);

    const person = new Person();
    person.x = spot.x;
    person.y = spot.y;
    person.score = spot.score;
    this.state.people.set(String(i), person);

    // 增量广播：这一拍只带新来的这一个人。
    this.broadcastPatch();

    this.entered++;
    return person;
  }
}
