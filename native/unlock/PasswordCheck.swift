// 密码核对的状态机（desk-unlock --listen 的密码框用；test/native/password-check/main.swift 单独测它）。
//
// 底层核对（OpenDirectory 的 verifyPassword）一旦开始就取消不了：目录服务、网络账户卡住时它可能很久才回来，
// 回来时照样算一次登录尝试。所以：
// - 同一时间最多一个底层核对在跑。界面等它最多 timeout 秒，等不到就先放开（.timeout），
//   但底层那个还没回来之前，再按回车不会再发起新的核对，直接回 .busy；
// - 每次等待带轮次号：超时或 cancel() 以后晚到的结果不交给界面，晚到的「对了」不会解锁；
//   晚到的「不对」照样记一次失败（底层确实试过一次了）。
// 防暴力试密码，照着 macOS 锁屏：连着输错 FREE_FAILURES 次以后，每再错一次就要等更久才能再试
// （1、5、15、60 分钟，之后都是 60 分钟），等的期间按回车不发起核对，直接回 .throttled（指纹照样能用）。
// 失败次数、等到什么时候存在 ThrottleStore 里（desk-unlock 写到屏保数据目录的文件里），进程重启不清零；
// 认出指纹、密码对了才清零。
// 「不是密码不对」的错（账户被锁、被停用、密码过期、目录服务出错……）回 .unavailable：这类交给系统验证框处理，
// 它知道怎么走账户策略。
// 状态只在 callbackQueue 上改（start / cancel / succeeded 也要在它上面调，desk-unlock 里是主线程）。
import Foundation

/// 底层核对一次的结果
enum VerifyResult: Equatable {
  /// 密码对
  case ok
  /// 密码不对（只有这种算一次失败）
  case wrong
  /// 别的原因核对不了：账户策略、目录服务出错……（带原因，给日志看）
  case error(String)
}

extension VerifyResult {
  /// OpenDirectory 的 verifyPassword 抛出来的错 → 核对结果。只有「凭证不对」（kODErrorCredentialsInvalid 5000）
  /// 算密码不对；账户被锁 / 停用 / 过期（53xx）、密码过期要改（54xx）、目录服务连不上（52xx）……都算核对不了，
  /// 交给系统验证框（它知道怎么走这些账户策略）
  static func from(openDirectoryError error: Error) -> VerifyResult {
    let e = error as NSError
    if e.domain == "com.apple.OpenDirectory", e.code == 5000 { return .wrong }
    return .error("\(e.domain) \(e.code) \(e.localizedDescription)")
  }
}

/// 失败次数、要等到什么时候；存哪儿由调用的人决定
protocol ThrottleStore: AnyObject {
  func load() -> (failures: Int, lockedUntil: Date?)
  func save(failures: Int, lockedUntil: Date?)
}

/// 只放内存（测试、没给状态文件时）
final class MemoryThrottleStore: ThrottleStore {
  var failures = 0
  var lockedUntil: Date?
  func load() -> (failures: Int, lockedUntil: Date?) { (failures, lockedUntil) }
  func save(failures: Int, lockedUntil: Date?) {
    self.failures = failures
    self.lockedUntil = lockedUntil
  }
}

/// 存成一个小 JSON 文件：{"failures": 3, "lockedUntil": 1795170000.5}；读不了当没有，写不了不管（退回只在内存里）
final class FileThrottleStore: ThrottleStore {
  let path: String
  private var cache: (Int, Date?)? = nil
  init(path: String) { self.path = path }
  func load() -> (failures: Int, lockedUntil: Date?) {
    if let c = cache { return c }
    var out: (Int, Date?) = (0, nil)
    if let data = FileManager.default.contents(atPath: path),
      let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    {
      let n = (obj["failures"] as? NSNumber)?.intValue ?? 0
      let until = (obj["lockedUntil"] as? NSNumber).map { Date(timeIntervalSince1970: $0.doubleValue) }
      out = (max(0, n), until)
    }
    cache = out
    return out
  }
  func save(failures: Int, lockedUntil: Date?) {
    cache = (failures, lockedUntil)
    var obj: [String: Any] = ["failures": failures]
    if let u = lockedUntil { obj["lockedUntil"] = u.timeIntervalSince1970 }
    guard let data = try? JSONSerialization.data(withJSONObject: obj) else { return }
    let url = URL(fileURLWithPath: path)
    try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
    try? data.write(to: url, options: .atomic)
  }
}

final class PasswordCheck {
  enum Outcome: Equatable {
    /// 密码对
    case ok
    /// 密码不对；lockedFor > 0：这次错完要等这么多秒才能再试
    case wrong(lockedFor: TimeInterval)
    /// 等了 timeout 秒没回来：这次作废，底层的还在跑
    case timeout
    /// 上一次底层核对还没回来，这次没发起
    case busy
    /// 输错太多次，还要等这么多秒，这次没发起
    case throttled(TimeInterval)
    /// 不是密码不对的错（账户策略、目录服务……）：交给系统验证框
    case unavailable(String)
  }

  /// 连着错这么多次以内不用等
  static let FREE_FAILURES = 4
  /// 连着错了 failures 次以后要等多久（秒）：照着 macOS 锁屏，第 5 次起 1、5、15、60 分钟
  static func delay(afterFailures failures: Int) -> TimeInterval {
    switch failures - FREE_FAILURES {
    case ..<1: return 0
    case 1: return 60
    case 2: return 5 * 60
    case 3: return 15 * 60
    default: return 60 * 60
    }
  }

  private let timeout: TimeInterval
  private let verify: (String) -> VerifyResult
  private let worker: DispatchQueue
  private let callbackQueue: DispatchQueue
  private let store: ThrottleStore
  private let now: () -> Date
  private var round = 0

  /// 界面在等结果
  private(set) var waiting = false
  /// 底层核对在跑（超时以后可能还在跑）
  private(set) var inFlight = false

  /// verify 在 worker 上跑、可以卡住；结果都回到 callbackQueue
  init(
    timeout: TimeInterval,
    store: ThrottleStore = MemoryThrottleStore(),
    now: @escaping () -> Date = Date.init,
    worker: DispatchQueue = .global(qos: .userInitiated),
    callbackQueue: DispatchQueue = .main,
    verify: @escaping (String) -> VerifyResult
  ) {
    self.timeout = timeout
    self.store = store
    self.now = now
    self.worker = worker
    self.callbackQueue = callbackQueue
    self.verify = verify
  }

  /// 还要等多少秒才能再试（0 = 现在就能）
  var lockedFor: TimeInterval {
    guard let until = store.load().lockedUntil else { return 0 }
    return max(0, until.timeIntervalSince(now()))
  }

  /// 核对 password，结果交给 done（在 callbackQueue 上，每次 start 最多一次）；已经在等了就不理
  func start(_ password: String, done: @escaping (Outcome) -> Void) {
    guard !waiting else { return }
    guard !inFlight else { return done(.busy) }
    let wait = lockedFor
    guard wait <= 0 else { return done(.throttled(wait)) }
    waiting = true
    inFlight = true
    round += 1
    let mine = round
    worker.async { [self] in
      let result = verify(password)
      callbackQueue.async { [self] in
        inFlight = false
        // 底层确实试过一次：不管界面还等不等，错了都记一次
        var locked: TimeInterval = 0
        if result == .wrong { locked = recordFailure() }
        guard waiting, mine == round else { return } // 超时了 / 取消了：作废的那次（晚到的「对了」不解锁）
        waiting = false
        switch result {
        case .ok:
          succeeded()
          done(.ok)
        case .wrong: done(.wrong(lockedFor: locked))
        case .error(let why): done(.unavailable(why))
        }
      }
    }
    callbackQueue.asyncAfter(deadline: .now() + timeout) { [self] in
      guard waiting, mine == round else { return }
      waiting = false
      round += 1
      done(.timeout)
    }
  }

  /// 不等了（收起密码框）：结果不再交给界面；底层的照样跑完，跑完之前不会发起新的
  func cancel() {
    guard waiting else { return }
    waiting = false
    round += 1
  }

  /// 验证过了（密码对、认出指纹）：失败次数清零
  func succeeded() {
    store.save(failures: 0, lockedUntil: nil)
  }

  /// 记一次失败；返回这次错完要等多少秒
  private func recordFailure() -> TimeInterval {
    let failures = store.load().failures + 1
    let wait = PasswordCheck.delay(afterFailures: failures)
    store.save(failures: failures, lockedUntil: wait > 0 ? now().addingTimeInterval(wait) : nil)
    return wait
  }
}
