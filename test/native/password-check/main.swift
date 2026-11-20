// PasswordCheck 的测试（top-level 代码只能放在 main.swift 里，所以单独一个目录）：跟 native/unlock/PasswordCheck.swift 一起编（test/password-check.test.js 负责编和跑）。
// 底层核对换成可控的假 verify：记调用次数，可以卡住、再放行。全部通过打 PASS，退出码 0。
import Foundation

let cb = DispatchQueue(label: "callbacks")
var failures = 0
func check(_ ok: Bool, _ what: String, line: Int = #line) {
  if !ok {
    failures += 1
    print("FAIL line \(line): \(what)")
  }
}

/// 假的底层核对：password == "right" 才算对；hold 为 true 时卡在 gate 上，直到 release()
final class FakeVerify {
  let lock = NSLock()
  private var _calls: [String] = []
  var calls: [String] { lock.lock(); defer { lock.unlock() }; return _calls }
  var hold = false
  let gate = DispatchSemaphore(value: 0)
  /// 每次调用开始时 signal，测试可以等「底层确实开始了」
  let started = DispatchSemaphore(value: 0)
  /// 每次调用结束时 signal
  let returned = DispatchSemaphore(value: 0)
  func run(_ pw: String) -> Bool {
    lock.lock(); _calls.append(pw); lock.unlock()
    started.signal()
    if hold { gate.wait() }
    defer { returned.signal() }
    return pw == "right"
  }
  func release() { gate.signal() }
}

/// 在 cb 上调 start，收集结果
final class Probe {
  let lock = NSLock()
  private var _outcomes: [PasswordCheck.Outcome] = []
  var outcomes: [PasswordCheck.Outcome] { lock.lock(); defer { lock.unlock() }; return _outcomes }
  let got = DispatchSemaphore(value: 0)
  func start(_ pc: PasswordCheck, _ pw: String) {
    cb.sync {
      pc.start(pw) { o in
        self.lock.lock(); self._outcomes.append(o); self.lock.unlock()
        self.got.signal()
      }
    }
  }
  func wait(_ seconds: Double = 2) -> Bool { got.wait(timeout: .now() + seconds) == .success }
}
/// 等 cb 上排着的活都跑完
func drain() { cb.sync {} }
func state(_ pc: PasswordCheck) -> (waiting: Bool, inFlight: Bool) { cb.sync { (pc.waiting, pc.inFlight) } }

// 1. 密码对 / 不对
do {
  let fake = FakeVerify()
  let pc = PasswordCheck(timeout: 1, callbackQueue: cb, verify: fake.run)
  let p = Probe()
  p.start(pc, "right")
  check(p.wait(), "right: got an outcome")
  p.start(pc, "nope")
  check(p.wait(), "wrong: got an outcome")
  check(p.outcomes == [.ok, .wrong], "outcomes \(p.outcomes)")
  check(fake.calls == ["right", "nope"], "calls \(fake.calls)")
  check(state(pc) == (false, false), "idle afterwards")
}

// 2. 超时 → 重试时上一次还没回来：不再发起（busy）→ 旧的晚到「对了」不交给界面 → 再试才发起新的
do {
  let fake = FakeVerify()
  fake.hold = true
  let pc = PasswordCheck(timeout: 0.2, callbackQueue: cb, verify: fake.run)
  let p = Probe()
  p.start(pc, "right")
  check(fake.started.wait(timeout: .now() + 2) == .success, "first verify started")
  check(p.wait(), "timeout: got an outcome")
  check(p.outcomes == [.timeout], "timed out: \(p.outcomes)")
  check(state(pc) == (false, true), "after timeout: not waiting, still in flight")
  p.start(pc, "right")
  check(p.wait(), "busy: got an outcome")
  check(p.outcomes == [.timeout, .busy], "retry while in flight is busy: \(p.outcomes)")
  check(fake.calls.count == 1, "no second underlying verify while the first is stuck: \(fake.calls)")
  // 旧的终于回来了，而且是「对了」：作废的那次，不能解锁
  fake.hold = false
  fake.release()
  check(fake.returned.wait(timeout: .now() + 2) == .success, "first verify returned")
  drain()
  check(!p.wait(0.3), "late result of the timed-out attempt is dropped")
  check(p.outcomes == [.timeout, .busy], "still \(p.outcomes)")
  check(state(pc) == (false, false), "idle once the stuck verify returned")
  // 现在才能再发起
  p.start(pc, "right")
  check(p.wait(), "retry after it returned: got an outcome")
  check(p.outcomes == [.timeout, .busy, .ok], "retry goes through: \(p.outcomes)")
  check(fake.calls.count == 2, "exactly one new underlying verify: \(fake.calls)")
}

// 3. 收起密码框（cancel）以后：晚到的「对了」不交给界面；没回来之前也不发起新的
do {
  let fake = FakeVerify()
  fake.hold = true
  let pc = PasswordCheck(timeout: 5, callbackQueue: cb, verify: fake.run)
  let p = Probe()
  p.start(pc, "right")
  check(fake.started.wait(timeout: .now() + 2) == .success, "verify started")
  cb.sync { pc.cancel() }
  check(state(pc) == (false, true), "cancelled: not waiting, still in flight")
  p.start(pc, "right")
  check(p.wait(), "busy after cancel")
  check(p.outcomes == [.busy], "busy: \(p.outcomes)")
  fake.hold = false
  fake.release()
  check(fake.returned.wait(timeout: .now() + 2) == .success, "verify returned")
  drain()
  check(!p.wait(0.3), "late success after cancel is dropped")
  check(fake.calls.count == 1, "one underlying verify: \(fake.calls)")
}

// 4. 已经在等结果时再按回车：不理，不发起第二个
do {
  let fake = FakeVerify()
  fake.hold = true
  let pc = PasswordCheck(timeout: 5, callbackQueue: cb, verify: fake.run)
  let p = Probe()
  p.start(pc, "nope")
  check(fake.started.wait(timeout: .now() + 2) == .success, "verify started")
  p.start(pc, "nope")
  check(!p.wait(0.2), "second start while waiting gives no outcome")
  check(fake.calls.count == 1, "no second underlying verify: \(fake.calls)")
  fake.release()
  check(p.wait(), "the first one answers")
  check(p.outcomes == [.wrong], "wrong: \(p.outcomes)")
}

if failures == 0 {
  print("PASS")
  exit(0)
}
exit(1)
