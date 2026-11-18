// 屏保解锁：用系统的身份验证确认是本人。三种用法：
//
//   desk-unlock [--lang zh|en] [提示语]
//     弹系统验证框：Touch ID，不行就登录密码。按键 / 点屏保时用。
//
//   desk-unlock --listen [--lang zh|en] [提示语]
//     不弹框，直接等指纹：盖一层看不见的窗口在主屏上（压在屏保上面一层），底部放系统的 Touch ID 图标
//     （LocalAuthenticationEmbeddedUI），自己当前台程序（Touch ID 只认前台程序）。摸一下传感器就解开。
//     图标平时是透明的（跟系统锁屏一样只有屏保网页上那行「使用触控 ID 或输入密码」），摸到传感器才淡出来。
//     只认指纹；有人按键或点一下就退出码 3，由屏保弹系统验证框（可以输密码）。
//     每次摸到传感器（不管认没认出来）打一行 touch，屏保收到就把 30 秒后藏起来的提示、状态栏再露出来。
//     合着盖子（系统报「closed clamshell mode」，内置传感器用不了）就先等着，盖子一开马上接着等指纹；
//     刚打开那几秒传感器还没回来，报错也不算数。只有没录指纹、没设密码、指纹被锁才算这台电脑做不了（退出码 2）。
//
//   desk-unlock --status
//     打印一行 JSON：电池（没有电池是 null）和 Wi-Fi（没有无线网卡是 null），屏保右上角的状态图标用。
//
// 退出码：0 验证通过；1 没通过或被取消（可以再来）；2 这台电脑做不了这种验证（没指纹、指纹被锁、没设密码……）；
// 3 有人按键 / 点了一下，要输密码。
// 最后一行输出是原因；--listen 时摸到传感器还会先打一行 touch。
import AppKit
import CoreWLAN
import Foundation
import IOKit
import IOKit.ps
import LocalAuthentication
import LocalAuthenticationEmbeddedUI

var args = Array(CommandLine.arguments.dropFirst())

if args.first == "--status" {
  var out: [String: Any] = ["battery": NSNull(), "wifi": NSNull()]
  let info = IOPSCopyPowerSourcesInfo().takeRetainedValue()
  let sources = IOPSCopyPowerSourcesList(info).takeRetainedValue() as [CFTypeRef]
  for ps in sources {
    guard let d = IOPSGetPowerSourceDescription(info, ps)?.takeUnretainedValue() as? [String: Any],
      d[kIOPSTypeKey] as? String == kIOPSInternalBatteryType,
      let cur = d[kIOPSCurrentCapacityKey] as? Int, let max = d[kIOPSMaxCapacityKey] as? Int, max > 0
    else { continue }
    out["battery"] = [
      "percent": Int((Double(cur) / Double(max) * 100).rounded()),
      "charging": d[kIOPSIsChargingKey] as? Bool ?? false,
      "plugged": d[kIOPSPowerSourceStateKey] as? String == kIOPSACPowerValue,
    ]
    break
  }
  if let wifi = CWWiFiClient.shared().interface() {
    // rssi 是 0 表示没连上（SSID 要定位权限，这里不要）
    let rssi = wifi.powerOn() ? wifi.rssiValue() : 0
    out["wifi"] = ["on": wifi.powerOn(), "connected": rssi != 0, "rssi": rssi]
  }
  let data = try! JSONSerialization.data(withJSONObject: out)
  print(String(data: data, encoding: .utf8)!)
  exit(0)
}

let listen = args.first == "--listen"
if listen { args.removeFirst() }
/// 界面语言：--lang en / zh；不给就看系统首选语言
var english = !(Locale.preferredLanguages.first ?? "zh").hasPrefix("zh")
if args.first == "--lang", args.count > 1 {
  english = args[1] != "zh"
  args.removeFirst(2)
}
let reason = args.first ?? (english ? "Unlock the screen saver" : "解锁屏保")

func finish(_ ok: Bool, _ why: String, unavailable: Bool = false) -> Never {
  print(ok ? "ok" : (unavailable ? "unavailable \(why)" : "denied \(why)"))
  exit(ok ? 0 : (unavailable ? 2 : 1))
}

/// 这些错误再试也没用：交给按键 + 密码那条路。
/// 不算 biometryNotAvailable：合盖、刚开盖传感器还没回来时也报它，那是暂时的（见 lidClosed）
func hopeless(_ error: Error?) -> Bool {
  guard let e = error as? LAError else { return false }
  switch e.code {
  case .biometryLockout, .biometryNotEnrolled, .passcodeNotSet, .notInteractive: return true
  default: return false
  }
}

/// 盖子是不是合着（IOPMrootDomain 的 AppleClamshellState）。合着时内置的 Touch ID 用不了；
/// 外接带 Touch ID 的妙控键盘不受影响，所以只在验证失败时才看它。读不到当作开着
func lidClosed() -> Bool {
  let root = IOServiceGetMatchingService(kIOMainPortDefault, IOServiceMatching("IOPMrootDomain"))
  guard root != 0 else { return false }
  defer { IOObjectRelease(root) }
  let v = IORegistryEntryCreateCFProperty(root, "AppleClamshellState" as CFString, kCFAllocatorDefault, 0)?.takeRetainedValue()
  return (v as? Bool) ?? false
}

/// 开盖以后传感器要一会儿才回来：这么久之内的失败都再试
let REOPEN_GRACE: TimeInterval = 5

let ctx = LAContext()
var err: NSError?

if !listen {
  ctx.localizedCancelTitle = english ? "Cancel" : "取消"
  guard ctx.canEvaluatePolicy(.deviceOwnerAuthentication, error: &err) else {
    finish(false, err?.localizedDescription ?? "", unavailable: true)
  }
  let done = DispatchSemaphore(value: 0)
  var ok = false
  var why = ""
  ctx.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason) { success, error in
    ok = success
    why = error?.localizedDescription ?? ""
    done.signal()
  }
  done.wait()
  finish(ok, why)
}

// 能不能等指纹：能就往下走；合着盖子就等它打开；刚开盖的几秒里失败也再试。
// 等的时候没有盖住屏幕的窗口，有人按键 / 点一下是屏保网页自己收到，照样弹密码框
var graceUntil: Date? = nil
while !ctx.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &err) {
  if hopeless(err) { finish(false, err?.localizedDescription ?? "", unavailable: true) }
  if lidClosed() {
    graceUntil = nil
  } else {
    // 盖子开着也先等几秒：刚开盖时传感器还没回来，canEvaluatePolicy 失败时 biometryType 也读不准（可能是 none），
    // 分不清「没有 Touch ID」还是「还没回来」。没有 Touch ID 的机器只是多等 5 秒才退回按键 + 密码
    if graceUntil == nil { graceUntil = Date().addingTimeInterval(REOPEN_GRACE) }
    if Date() > graceUntil! { finish(false, err?.localizedDescription ?? "", unavailable: true) }
  }
  Thread.sleep(forTimeInterval: 0.3)
  err = nil
}

// 自己当前台程序：Touch ID 只认前台程序的验证。屏保（Electron）的 kiosk 只在它自己在前台时有效，
// 所以这里自己再禁一遍 Cmd+Tab、强制退出这些。
let app = NSApplication.shared
app.setActivationPolicy(.accessory) // 不进程序坞

/// 盖住整块主屏、看不见的窗口：收键盘和鼠标（有人按键 / 点一下就退出码 3，交给屏保弹密码框），
/// 底部正中放系统的指纹图标，在屏保网页那行「使用触控 ID 或输入密码」（离底边 7%）上面。
final class Cover: NSWindow {
  override var canBecomeKey: Bool { true }
  override var canBecomeMain: Bool { true }
  // 在窗口收事件的最入口拦：不管落在哪个子视图（指纹图标、文字、空白处）、谁是 first responder 都收得到
  override func sendEvent(_ event: NSEvent) {
    switch event.type {
    case .keyDown, .leftMouseDown, .rightMouseDown, .otherMouseDown: wantsPassword()
    default: super.sendEvent(event)
    }
  }
}

func wantsPassword() -> Never {
  print("password")
  exit(3)
}

guard let screen = NSScreen.screens.first else { finish(false, "没有屏幕", unavailable: true) }
let frame = screen.frame
let win = Cover(contentRect: frame, styleMask: .borderless, backing: .buffered, defer: false)
win.isOpaque = false
win.backgroundColor = .clear
win.hasShadow = false
win.ignoresMouseEvents = false // 明确设成 false：透明的地方也收鼠标
win.acceptsMouseMovedEvents = true
win.level = NSWindow.Level(rawValue: Int(CGWindowLevelForKey(.screenSaverWindow)) + 1)
win.collectionBehavior = [.canJoinAllSpaces, .stationary, .fullScreenAuxiliary, .ignoresCycle]

let root = NSView(frame: NSRect(origin: .zero, size: frame.size))
let view = LAAuthenticationView(context: ctx, controlSize: .regular)
view.translatesAutoresizingMaskIntoConstraints = false
root.addSubview(view)
NSLayoutConstraint.activate([
  view.centerXAnchor.constraint(equalTo: root.centerXAnchor),
  view.bottomAnchor.constraint(equalTo: root.bottomAnchor, constant: -(frame.height * 0.07 + 30)),
])
win.contentView = root

app.presentationOptions = [.hideDock, .hideMenuBar, .disableProcessSwitching, .disableForceQuit, .disableSessionTermination, .disableHideApplication]
win.makeKeyAndOrderFront(nil)
app.activate(ignoringOtherApps: true)

// 指纹图标平时透明，摸到传感器（认出来 / 没认出来）才淡出来，过一会儿再淡掉。
// 只调里面那层画图标的视图（PKGlyphView）：LAAuthenticationView 自己和外面那层会查自己是不是被藏起来了。
// 系统没给「手指放上来了」的公开回调，这里挂 LAAuthenticationView 的私有方法：
// - 两个回调（认出来 / 没认出来）：把图标淡出来；
// - layout：图标视图是开始验证以后才建的，每次布局完（在画出来之前）把它压回透明，免得闪一下。
// 以后系统改名了挂不上：认出 / 没认出的挂不上就只是图标不出来；layout 是公开方法，一直挂得上。
func findGlyph(_ v: NSView) -> NSView? {
  if NSStringFromClass(type(of: v)).contains("Glyph") { return v }
  for s in v.subviews { if let g = findGlyph(s) { return g } }
  return nil
}
var glyphShown = false
var hideGlyph: DispatchWorkItem?
func keepGlyphHidden() {
  if !glyphShown, let g = findGlyph(view), g.alphaValue != 0 { g.alphaValue = 0 }
}
func flashGlyph() {
  guard let glyph = findGlyph(view) else { return }
  glyphShown = true
  hideGlyph?.cancel()
  NSAnimationContext.runAnimationGroup { c in
    c.duration = 0.18
    glyph.animator().alphaValue = 1
  }
  let work = DispatchWorkItem {
    NSAnimationContext.runAnimationGroup({ c in
      c.duration = 0.6
      glyph.animator().alphaValue = 0
    }, completionHandler: { glyphShown = false })
  }
  hideGlyph = work
  DispatchQueue.main.asyncAfter(deadline: .now() + 2.4, execute: work)
}
/// 给 LAAuthenticationView 的方法 name 后面接一段 then（调完原来的再跑）；签名对不上就不挂
func hook(_ name: String, encoding: String, then: @escaping () -> Void) {
  let sel = NSSelectorFromString(name)
  guard let cls = NSClassFromString("LAAuthenticationView"), let m = class_getInstanceMethod(cls, sel),
    String(cString: method_getTypeEncoding(m)!).hasPrefix(encoding)
  else { return }
  if encoding == "v16@0:8" {
    typealias Original = @convention(c) (AnyObject, Selector) -> Void
    let original = unsafeBitCast(method_getImplementation(m), to: Original.self)
    let block: @convention(block) (AnyObject) -> Void = { me in
      original(me, sel)
      then()
    }
    method_setImplementation(m, imp_implementationWithBlock(block))
  } else {
    typealias Original = @convention(c) (AnyObject, Selector, AnyObject?) -> Void
    let original = unsafeBitCast(method_getImplementation(m), to: Original.self)
    let block: @convention(block) (AnyObject, AnyObject?) -> Void = { me, model in
      original(me, sel, model)
      then()
    }
    method_setImplementation(m, imp_implementationWithBlock(block))
  }
}
hook("layout", encoding: "v16@0:8", then: keepGlyphHidden)
/// 摸到传感器：图标淡出来，再打一行 touch match / touch miss 告诉屏保（它会把藏起来的提示、状态栏露出来，主题可以拿来做反馈）
func touched(_ match: Bool) {
  flashGlyph()
  print(match ? "touch match" : "touch miss")
  fflush(stdout)
}
hook("authenticationViewModelDidReceiveBiometryNoMatch:", encoding: "v24@0:8@16") { DispatchQueue.main.async { touched(false) } }
hook("authenticationViewModelDidReceiveBiometryMatch:", encoding: "v24@0:8@16") { DispatchQueue.main.async { touched(true) } }
// 布局之外也兜一下：每 0.1 秒看一眼（便宜，只比一个数）
func patrolGlyph() {
  keepGlyphHidden()
  DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { patrolGlyph() }
}
patrolGlyph()

func evaluate() {
  // 被 kill 的时候 LAContext 跟着进程没了，传感器自然放开
  ctx.evaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, localizedReason: reason) { success, error in
    DispatchQueue.main.async {
      // 认出来了：先让图标露半秒（不然窗口一关，淡入还没开始人就看不到），再退出关屏保
      if success {
        if findGlyph(view) != nil {
          flashGlyph()
          DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { finish(true, "") }
          return
        }
        finish(true, "")
      }
      let code = (error as? LAError)?.code.rawValue ?? 0
      // 合盖时这里会报「配件已断开」（-13）之类：退出码 1，屏保一秒后重起，新起的那个会等盖子打开
      finish(false, "\(code) \(error?.localizedDescription ?? "")", unavailable: hopeless(error) && !lidClosed())
    }
  }
}
// 等窗口真的到前台再开始验证
DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) {
  evaluate()
}
app.run()
