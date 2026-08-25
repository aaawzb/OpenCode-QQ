# gw-fix-report：WSS 网关统一错误码接入与协议缺陷修复

## 状态
完成。`fix/gw` 分支，提交 `fix(gw): op7/op9/close-code 分级与心跳超时`。

## 修复内容（严格 TDD：先写失败测试 → 实现 → 转绿）
1. **op9 Invalid Session**（GW004）：收到 op=9 时告警、清空 sessionId/lastSeq/resumeAttempted、terminate 触发重连，下次全新 Identify。
2. **op7 Reconnect**（GW005）：告警并主动 terminate 重连；保留会话以便重连后 Resume。
3. **close code 分级**：
   - 4013/4014 → GW006（error 级），halt()：stopped 置位 + 清理全部定时器/连接，不再重连
   - 4914/4915 → GW007（error 级），同上停止重连
   - 4010/4001-4005 → GW008（warn），清空会话后按退避重连
   - 其余 code → GW003（warn），原退避逻辑重连
4. **心跳 ack 超时**（GW009）：记录 lastAckAt（每次 HELLO 重置、op11 刷新）；心跳 tick 时若超过 2×heartbeat_interval 无任何 ack 则判定半开连接，terminate 强制重连。
5. **session_id 防污染**：READY 中 session_id 非非空字符串时不写入会话。

## 测试
- gateway.test.ts：9 个既有用例保持绿色；新增 8 个用例覆盖 op9/op7/4013+4014/4915/4010/其他 close code/心跳超时(无 ack)/心跳正常不误杀/session_id 污染。
- `bunx vitest run tests/qq/gateway.test.ts`：17/17 绿。
- 全量套件：17 文件 / 86 用例全绿。
- `tsc --noEmit` 干净。

## 关键发现与疑虑
- **qqLog 第二参是 ErrKey 字符串**（内部 `E[key]`），不是 spec 对象。若传 `E.X` 对象会运行时抛 `Cannot read properties of undefined (reading 'code')` 且 esbuild/vitest 不做类型检查无法拦截——建议 errors.ts 的 JSDoc 明确标注，或让 qqLog 兼容两种入参（本次未改 errors.ts）。
- op9 场景中被拒的那条连接不会产生 RESUMED/connected 回调，测试断言按"两次 connected"设计。
- 心跳超时阈值用严格大于 `> 2×interval`，对定时器抖动留了天然裕量；正常 ack 流（15~25ms 小间隔压测 300ms 多拍）验证无误杀。
