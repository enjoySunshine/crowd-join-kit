# crowd-join-kit

1500 个人逐个进房间，进一个发一拍，每一拍**只发新来的那一个**（增量），
不重发全场：1500 拍发完 < 180 毫秒，增量合计 < 40 万字节，对面 1500 个点
一个一个多起来，第一个 (120, 80) 分数 7，最后一个 (169, 80) 分数 7。

kit 在 [`packages/crowd-join-kit`](packages/crowd-join-kit)：

```sh
pnpm --filter @colyseus/crowd-join-kit test    # 约束测试
pnpm --filter @colyseus/crowd-join-kit bench   # 基准（delta 模式）
pnpm --filter @colyseus/crowd-join-kit bench -- --full   # 反例：每拍重发全场
```
