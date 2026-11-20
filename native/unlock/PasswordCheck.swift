// 密码核对的状态机（desk-unlock --listen 的密码框用；test/native/password-check.swift 单独测它）。
//
// 底层核对（OpenDirectory 的 verifyPassword）一旦开始就取消不了：目录服务、网络账户卡住时它可能很久才回来，
// 回来时照样算一次登录尝试（输错会计入系统的失败次数）。所以：
// - 同一时间最多一个底层核对在跑。界面等它最多 timeout 秒，等不到就先放开（.timeout），
//   但底层那个还没回来之前，再按回车不会再发起新的核对，直接回 .busy；
// - 每次等待带轮次号：超时或 cancel() 以后晚到的结果（包括晚到的「对了」）不交给界面，不会误解锁；
// - 密码只被在跑的那一个核对拿着，不会随重试越积越多。
// 状态只在 callbackQueue 上改（start / cancel 也要在它上面调，desk-unlock 里是主线程）。
import Foundation

final class PasswordCheck {
  enum Outcome: Equatable {
    /// 密码对
    case ok
    /// 密码不对（或核对出错）
    case wrong
    /// 等了 timeout 秒没回来：这次作废，底层的还在跑
    case timeout
    /// 上一次底层核对还没回来，这次没发起
    case busy
  }

  private let timeout: TimeInterval
  private let verify: (String) -> Bool
  private let worker: DispatchQueue
  private let callbackQueue: DispatchQueue
  private var round = 0

  /// 界面在等结果
  private(set) var waiting = false
  /// 底层核对在跑（超时以后可能还在跑）
  private(set) var inFlight = false

  /// verify 在 worker 上跑、可以卡住；结果都回到 callbackQueue
  init(
    timeout: TimeInterval,
    worker: DispatchQueue = .global(qos: .userInitiated),
    callbackQueue: DispatchQueue = .main,
    verify: @escaping (String) -> Bool
  ) {
    self.timeout = timeout
    self.worker = worker
    self.callbackQueue = callbackQueue
    self.verify = verify
  }

  /// 核对 password，结果交给 done（在 callbackQueue 上，每次 start 最多一次）；已经在等了就不理
  func start(_ password: String, done: @escaping (Outcome) -> Void) {
    guard !waiting else { return }
    guard !inFlight else { return done(.busy) }
    waiting = true
    inFlight = true
    round += 1
    let mine = round
    worker.async { [self] in
      let ok = verify(password)
      callbackQueue.async { [self] in
        inFlight = false
        guard waiting, mine == round else { return } // 超时了 / 取消了：作废的那次
        waiting = false
        done(ok ? .ok : .wrong)
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
}
