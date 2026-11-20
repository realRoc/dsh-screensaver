// 屏保解锁：用系统的身份验证确认是本人。三种用法：
//
//   desk-unlock [--lang zh|en] [提示语]
//     弹系统验证框：Touch ID，不行就登录密码。等指纹那条路用不了时（没录指纹、指纹被锁……）按键 / 点屏保用它。
//
//   desk-unlock --listen [--lang zh|en] [提示语]
//     照着系统锁屏：盖一层看不见的窗口在主屏上（压在屏保上面一层），自己当前台程序（Touch ID 只认前台程序），
//     一边等指纹，一边等人输密码，两样同时都能用：
//     - 指纹：底部放系统的 Touch ID 图标（LocalAuthenticationEmbeddedUI），摸一下传感器就解开。图标平时藏着
//       （跟系统锁屏一样只有屏保网页上那行「使用触控 ID 或输入密码」），摸到传感器才淡出来。
//     - 密码：有人按键或点一下，就在那行字上面出一个密码框（自己画的，不弹系统验证框，所以指纹一直在等）。
//       回车用系统账户核对（OpenDirectory，跟登录同一套规则），密码不出这个进程。Esc 或 30 秒没动静就收起来。
//     每次摸到传感器（不管认没认出来）打一行 touch match / touch miss；密码框出来、收起、输错打 typing on / typing off /
//     password wrong，屏保收到就把 30 秒后藏起来的提示、状态栏再露出来。
//     合着盖子（系统报「closed clamshell mode」，内置传感器用不了）就先等着，盖子一开马上接着等指纹；
//     刚打开那几秒传感器还没回来，报错也不算数。只有没录指纹、没设密码、指纹被锁才算这台电脑做不了（退出码 2）。
//
//   desk-unlock --status
//     打印一行 JSON：电池（没有电池是 null）和 Wi-Fi（没有无线网卡是 null），屏保右上角的状态图标用。
//
// 退出码：0 验证通过；1 没通过或被取消（可以再来）；2 这台电脑做不了这种验证（没指纹、指纹被锁、没设密码……）；
// 3 有人按键 / 点了一下、要弹系统验证框（老版本 --listen 用，现在密码框自己画，不再这样退出）。
// 最后一行输出是原因。
import AppKit
import CoreWLAN
import Foundation
import IOKit
import IOKit.ps
import LocalAuthentication
import LocalAuthenticationEmbeddedUI
import OpenDirectory

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

/// 弹框用的、等指纹先探一下能不能用的；等指纹开始以后每轮换新的（startBio）
var ctx = LAContext()
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

// ---- 系统指纹控件的「看不见就暂停」：关掉遮挡检测，暂停卡住了自己重开 ----
//
// LAAuthenticationView 觉得自己看不见（窗口不是 key、程序不在前台、被别的东西挡住）就暂停指纹比对，看得见了再接着比。
// 它判断「被挡住」的那个私有视图（NSOcclusionDetectionView）会自己隔一会儿误报一次「挡住了」又马上「没挡」，
// 暂停那一下正在比对的手指就作废了；图标被重画得越勤（以前每 0.1 秒压一次透明度）误报越密，
// 密到每 0.1 秒一次时，手指按多久都比不完。还有一种更糟的：最后一下停在「暂停」再也不恢复，
// evaluatePolicy 不报错也不返回，屏保以为还在等，其实传感器早就交给系统别的功能了（2026-11-20 两次都在系统日志里查到）。
// 我们的窗口盖满整块屏幕、压在最上面，不存在真被挡住，所以：
// 1. 遮挡检测直接关掉（换掉它判断的方法，永远报「没挡」）；
// 2. 挂比对控件「看得见 / 看不见」的回调，自己记着；在前台、窗口是 key 却连着 2 秒还是「看不见」，
//    就把这次验证作废、重开一次（新的 LAContext + 新的图标视图），不用退出进程，密码框里打的字也不丢。
// 以后系统改了名字挂不上：1 不生效只是退回系统自己的行为；2 挂不上就当一直看得见，不会误重开。
if let cls = NSClassFromString("NSOcclusionDetectionView") {
  if let m = class_getInstanceMethod(cls, NSSelectorFromString("_evaluateOcclusionState")),
    String(cString: method_getTypeEncoding(m)!) == "v16@0:8"
  {
    let noop: @convention(block) (AnyObject) -> Void = { _ in }
    method_setImplementation(m, imp_implementationWithBlock(noop))
  }
  if let m = class_getInstanceMethod(cls, NSSelectorFromString("isOccluded")),
    String(cString: method_getTypeEncoding(m)!) == "B16@0:8"
  {
    let never: @convention(block) (AnyObject) -> Bool = { _ in false }
    method_setImplementation(m, imp_implementationWithBlock(never))
  }
}

/// 比对控件现在觉得自己看不见（会暂停）是从什么时候开始的；nil = 看得见
var bioHiddenSince: Date? = nil
if let cls = NSClassFromString("LACUIAuthenticationViewModel"),
  let m = class_getInstanceMethod(cls, NSSelectorFromString("viewVisibilityChangedToVisible:withDescription:")),
  String(cString: method_getTypeEncoding(m)!).hasPrefix("v28@0:8B16@20")
{
  let sel = NSSelectorFromString("viewVisibilityChangedToVisible:withDescription:")
  typealias Original = @convention(c) (AnyObject, Selector, Bool, AnyObject?) -> Void
  let original = unsafeBitCast(method_getImplementation(m), to: Original.self)
  let block: @convention(block) (AnyObject, Bool, AnyObject?) -> Void = { me, visible, desc in
    original(me, sel, visible, desc)
    DispatchQueue.main.async {
      if visible { bioHiddenSince = nil } else if bioHiddenSince == nil { bioHiddenSince = Date() }
    }
  }
  method_setImplementation(m, imp_implementationWithBlock(block))
}

// ---- 盖住整块主屏、看不见的窗口 ----

/// 收键盘和鼠标：密码框收着时，按键 / 点一下就把它拿出来（按的那个字直接打进去）；出来了就照常给密码框
final class Cover: NSWindow {
  override var canBecomeKey: Bool { true }
  override var canBecomeMain: Bool { true }
  // 在窗口收事件的最入口拦：不管落在哪个子视图、谁是 first responder 都收得到
  override func sendEvent(_ event: NSEvent) {
    switch event.type {
    case .keyDown:
      let opening = pwBox.isHidden
      if opening { showPassword() }
      pwIdle()
      if event.keyCode == 53 { // Esc：收起来（刚拿出来的那一下不算）
        if !opening { hidePassword() }
        return
      }
      // 没有菜单栏，Cmd+V / Cmd+A 不会自己生效，这里帮一把（密码框不让复制剪切）
      if event.modifierFlags.contains(.command) {
        let editor = pwField.currentEditor()
        switch event.charactersIgnoringModifiers {
        case "v": editor?.paste(nil)
        case "a": editor?.selectAll(nil)
        default: break
        }
        return
      }
      if opening, event.keyCode == 36 || event.keyCode == 76 { return } // 拿出来的那一下是回车：空的，不核对
      super.sendEvent(event)
    case .leftMouseDown, .rightMouseDown, .otherMouseDown:
      if pwBox.isHidden {
        showPassword()
        return
      }
      pwIdle()
      // 点在密码框里照常（挪光标）；点别处不让密码框丢了焦点
      let p = pwBox.convert(event.locationInWindow, from: nil)
      if event.type == .leftMouseDown, pwBox.bounds.contains(p) { super.sendEvent(event) }
      else { makeFirstResponder(pwField) }
    default: super.sendEvent(event)
    }
  }
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
win.appearance = NSAppearance(named: .darkAqua)

let root = NSView(frame: NSRect(origin: .zero, size: frame.size))
win.contentView = root

/// 屏保网页那行「使用触控 ID 或输入密码」离底边 7%、18 点高；密码框放在它上面，指纹图标再往上
let HINT_TOP = frame.height * 0.07 + 18

// ---- 密码框：照着系统锁屏，半透明圆角、白字，按键或点一下才出来 ----

let PW_W: CGFloat = 220
let PW_H: CGFloat = 28
let pwBox = NSView()
pwBox.translatesAutoresizingMaskIntoConstraints = false
pwBox.wantsLayer = true
pwBox.layer?.backgroundColor = NSColor(white: 1, alpha: 0.2).cgColor
pwBox.layer?.cornerRadius = PW_H / 2
pwBox.layer?.borderWidth = 0.5
pwBox.layer?.borderColor = NSColor(white: 1, alpha: 0.25).cgColor
pwBox.isHidden = true
root.addSubview(pwBox)

/// 回车 / Esc 交给我们
final class PasswordDelegate: NSObject, NSTextFieldDelegate {
  func control(_ control: NSControl, textView: NSTextView, doCommandBy sel: Selector) -> Bool {
    if sel == #selector(NSResponder.insertNewline(_:)) {
      checkPassword()
      return true
    }
    if sel == #selector(NSResponder.cancelOperation(_:)) {
      hidePassword()
      return true
    }
    return false
  }
}
let pwDelegate = PasswordDelegate()
let pwField = NSSecureTextField()
pwField.translatesAutoresizingMaskIntoConstraints = false
pwField.isBordered = false
pwField.drawsBackground = false
pwField.focusRingType = .none
pwField.alignment = .left
pwField.textColor = .white
pwField.font = .systemFont(ofSize: 13)
pwField.usesSingleLineMode = true
pwField.cell?.isScrollable = true
pwField.placeholderAttributedString = NSAttributedString(
  string: english ? "Enter Password" : "输入密码",
  attributes: [.foregroundColor: NSColor(white: 1, alpha: 0.55), .font: NSFont.systemFont(ofSize: 13)]
)
pwField.delegate = pwDelegate
pwBox.addSubview(pwField)
NSLayoutConstraint.activate([
  pwBox.widthAnchor.constraint(equalToConstant: PW_W),
  pwBox.heightAnchor.constraint(equalToConstant: PW_H),
  pwBox.centerXAnchor.constraint(equalTo: root.centerXAnchor),
  pwBox.bottomAnchor.constraint(equalTo: root.bottomAnchor, constant: -(HINT_TOP + 14)),
  pwField.leadingAnchor.constraint(equalTo: pwBox.leadingAnchor, constant: 12),
  pwField.trailingAnchor.constraint(equalTo: pwBox.trailingAnchor, constant: -12),
  pwField.centerYAnchor.constraint(equalTo: pwBox.centerYAnchor),
])

// ---- 指纹图标：放在一个容器里，平时用容器图层的遮罩藏起来 ----
// 不动图标视图自己的透明度、隐藏：比对控件盯着这些（KVO），一动就重画、重新判断看不看得见（见上面）。
// 遮罩是 Core Animation 那一层的事，视图层面的透明度、是否隐藏都没变

let glyphHolder = NSView()
glyphHolder.translatesAutoresizingMaskIntoConstraints = false
glyphHolder.wantsLayer = true
root.addSubview(glyphHolder)
/// 遮罩不透明度 0 = 图标全藏，1 = 全露
let glyphMask = CALayer()
glyphMask.backgroundColor = NSColor.black.cgColor
glyphMask.opacity = 0
glyphHolder.layer?.mask = glyphMask
/// 图标底边：密码框收着时在提示上面 30 点（以前的位置），出来了挪到密码框上面
let glyphLow = glyphHolder.bottomAnchor.constraint(equalTo: root.bottomAnchor, constant: -(HINT_TOP + 12))
let glyphHigh = glyphHolder.bottomAnchor.constraint(equalTo: pwBox.topAnchor, constant: -14)
NSLayoutConstraint.activate([glyphHolder.centerXAnchor.constraint(equalTo: root.centerXAnchor), glyphLow])

var hideGlyph: DispatchWorkItem?
func setGlyph(_ shown: Bool, _ duration: CFTimeInterval) {
  glyphHolder.layoutSubtreeIfNeeded()
  glyphMask.frame = glyphHolder.bounds.insetBy(dx: -40, dy: -40)
  let to: Float = shown ? 1 : 0
  let anim = CABasicAnimation(keyPath: "opacity")
  anim.fromValue = glyphMask.presentation()?.opacity ?? glyphMask.opacity
  anim.toValue = to
  anim.duration = duration
  glyphMask.opacity = to
  glyphMask.add(anim, forKey: "opacity")
}
/// 摸到传感器：图标淡出来，过一会儿再淡掉
func flashGlyph() {
  hideGlyph?.cancel()
  setGlyph(true, 0.18)
  let work = DispatchWorkItem { setGlyph(false, 0.6) }
  hideGlyph = work
  DispatchQueue.main.asyncAfter(deadline: .now() + 2.4, execute: work)
}

// ---- 密码框的拿出来、收起来、核对 ----

/// 输进去的东西这么久没动就收起来
let PW_IDLE: TimeInterval = 30
var pwIdleWork: DispatchWorkItem?
func pwIdle() {
  pwIdleWork?.cancel()
  let work = DispatchWorkItem { hidePassword() }
  pwIdleWork = work
  DispatchQueue.main.asyncAfter(deadline: .now() + PW_IDLE, execute: work)
}
func say(_ line: String) {
  print(line)
  fflush(stdout)
}
func showPassword() {
  guard pwBox.isHidden else { return }
  pwField.stringValue = ""
  pwField.isEnabled = true
  pwBox.isHidden = false
  glyphLow.isActive = false
  glyphHigh.isActive = true
  win.makeFirstResponder(pwField)
  (pwField.currentEditor() as? NSTextView)?.insertionPointColor = .white
  pwIdle()
  say("typing on")
}
func hidePassword() {
  pwIdleWork?.cancel()
  guard !pwBox.isHidden, !checking else { return }
  pwField.stringValue = ""
  pwBox.isHidden = true
  glyphHigh.isActive = false
  glyphLow.isActive = true
  win.makeFirstResponder(root)
  say("typing off")
  // 指纹这次屏保里已经用不了（被锁、被删）：没有密码框就没东西可等了，交给屏保（以后按键弹系统验证框）
  if let why = bioGone { finish(false, why, unavailable: true) }
}
/// 密码不对：左右晃一下，清空
func shake() {
  let anim = CAKeyframeAnimation(keyPath: "transform.translation.x")
  anim.values = [0, -10, 10, -8, 8, -4, 4, 0]
  anim.duration = 0.4
  pwBox.layer?.add(anim, forKey: "shake")
}
var checking = false
/// 回车：用系统账户核对（跟登录同一套规则：输错多了系统自己会锁），放到后台线程，不卡界面
func checkPassword() {
  let pw = pwField.stringValue
  guard !pw.isEmpty, !checking else { return }
  checking = true
  pwField.isEnabled = false
  DispatchQueue.global(qos: .userInitiated).async {
    var ok = false
    do {
      let node = try ODNode(session: ODSession.default(), type: ODNodeType(kODNodeTypeAuthentication))
      let rec = try node.record(withRecordType: kODRecordTypeUsers, name: NSUserName(), attributes: nil)
      try rec.verifyPassword(pw)
      ok = true
    } catch {}
    DispatchQueue.main.async {
      checking = false
      if ok { finish(true, "password") }
      pwField.stringValue = ""
      pwField.isEnabled = true
      win.makeFirstResponder(pwField)
      shake()
      pwIdle()
      say("password wrong")
    }
  }
}

// ---- 指纹比对：一次一个 LAContext + 一个图标视图，作废了就整个换新的 ----

var bioView: LAAuthenticationView? = nil
/// 第几次比对；作废的那次回调回来时对不上号就不理
var bioRound = 0
/// 这次屏保里指纹已经用不了的原因（被锁、没录……）：密码框还在就只靠密码
var bioGone: String? = nil
/// 指纹没在比（上一轮结束、新的还没开始）
var bioIdle = true

func startBio() {
  guard bioGone == nil else { return }
  bioRound += 1
  let round = bioRound
  ctx.invalidate() // 上一轮还挂着就作废（回调回来 round 对不上，不理）
  bioView?.removeFromSuperview()
  ctx = LAContext()
  var e: NSError?
  guard ctx.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &e) else {
    // 合盖、刚开盖传感器没回来这类：看门狗过一秒再试；做不了的就只靠密码
    if hopeless(e), !lidClosed() { bioFailed(e as Error?) }
    bioIdle = true
    return
  }
  let view = LAAuthenticationView(context: ctx, controlSize: .regular)
  view.translatesAutoresizingMaskIntoConstraints = false
  glyphHolder.addSubview(view)
  NSLayoutConstraint.activate([
    view.leadingAnchor.constraint(equalTo: glyphHolder.leadingAnchor),
    view.trailingAnchor.constraint(equalTo: glyphHolder.trailingAnchor),
    view.topAnchor.constraint(equalTo: glyphHolder.topAnchor),
    view.bottomAnchor.constraint(equalTo: glyphHolder.bottomAnchor),
  ])
  bioView = view
  bioHiddenSince = nil
  bioIdle = false
  ctx.evaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, localizedReason: reason) { success, error in
    DispatchQueue.main.async {
      guard round == bioRound else { return } // 我们自己作废的那轮
      bioIdle = true
      // 认出来了：先让图标露半秒（不然窗口一关，淡入还没开始人就看不到），再退出关屏保
      if success {
        flashGlyph()
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { finish(true, "") }
        return
      }
      if hopeless(error), !lidClosed() { return bioFailed(error) }
      // 没认出来几次、被系统取消、合盖时「配件已断开」（-13）……：
      // 密码框收着就照老规矩退出码 1，屏保一秒后重起（新起的那个会等盖子打开）；密码框开着别打断人打字，原地再来
      let code = (error as? LAError)?.code.rawValue ?? 0
      if pwBox.isHidden { finish(false, "\(code) \(error?.localizedDescription ?? "")") }
      DispatchQueue.main.asyncAfter(deadline: .now() + 1) { if bioIdle, round == bioRound { startBio() } }
    }
  }
}
/// 指纹这次屏保里用不了了：密码框收着就退出码 2（交给屏保），开着就只靠密码，收起来时再退
func bioFailed(_ error: Error?) {
  let why = "\((error as? LAError)?.code.rawValue ?? 0) \(error?.localizedDescription ?? "")"
  bioGone = why
  bioView?.removeFromSuperview()
  if pwBox.isHidden { finish(false, why, unavailable: true) }
}

/// 摸到传感器：图标淡出来，再打一行 touch match / touch miss 告诉屏保（它会把藏起来的提示、状态栏露出来，主题可以拿来做反馈）
func touched(_ match: Bool) {
  flashGlyph()
  say(match ? "touch match" : "touch miss")
}
/// 给 LAAuthenticationView 的方法 name 后面接一段 then（调完原来的再跑）；签名对不上就不挂
func hook(_ name: String, then: @escaping () -> Void) {
  let sel = NSSelectorFromString(name)
  guard let cls = NSClassFromString("LAAuthenticationView"), let m = class_getInstanceMethod(cls, sel),
    String(cString: method_getTypeEncoding(m)!).hasPrefix("v24@0:8@16")
  else { return }
  typealias Original = @convention(c) (AnyObject, Selector, AnyObject?) -> Void
  let original = unsafeBitCast(method_getImplementation(m), to: Original.self)
  let block: @convention(block) (AnyObject, AnyObject?) -> Void = { me, model in
    original(me, sel, model)
    then()
  }
  method_setImplementation(m, imp_implementationWithBlock(block))
}
// 系统没给「手指放上来了」的公开回调，挂 LAAuthenticationView 的私有方法；以后改名了挂不上就只是图标不出来
hook("authenticationViewModelDidReceiveBiometryNoMatch:") { DispatchQueue.main.async { touched(false) } }
hook("authenticationViewModelDidReceiveBiometryMatch:") { DispatchQueue.main.async { touched(true) } }

// ---- 前台、看门狗 ----

app.presentationOptions = [.hideDock, .hideMenuBar, .disableProcessSwitching, .disableForceQuit, .disableSessionTermination, .disableHideApplication]
win.makeKeyAndOrderFront(nil)
app.activate(ignoringOtherApps: true)

// 前台被别的程序拿走（比如屏保副屏窗口晚一步弹出来）就拿回来，不然 Touch ID 不理我们、摸了没反应、也打不了字。
NotificationCenter.default.addObserver(forName: NSApplication.didResignActiveNotification, object: nil, queue: .main) { _ in
  DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) {
    if !app.isActive {
      app.activate(ignoringOtherApps: true)
      win.makeKeyAndOrderFront(nil)
    }
  }
}

/// 在前台、窗口是 key，比对控件却连着这么久说自己看不见：当它卡在暂停里了，重开一轮
let STUCK_AFTER: TimeInterval = 2
func watchdog() {
  if app.isActive, win.isKeyWindow {
    if let since = bioHiddenSince, Date().timeIntervalSince(since) > STUCK_AFTER {
      startBio()
    } else if bioIdle, bioGone == nil, !checking {
      startBio() // 上一轮没开起来（合盖、传感器还没回来）：再试
    }
  } else if !app.isActive {
    app.activate(ignoringOtherApps: true)
    win.makeKeyAndOrderFront(nil)
  }
  DispatchQueue.main.asyncAfter(deadline: .now() + 1) { watchdog() }
}

// 等窗口真的到前台再开始验证
DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) {
  startBio()
  watchdog()
}
app.run()
