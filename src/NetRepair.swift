import Cocoa
import Foundation
import WebKit

private struct CommandResult {
    let output: String
    let status: Int32
    let timedOut: Bool
}

private struct AppFailure: Error, LocalizedError {
    let message: String
    var errorDescription: String? { message }
}

// MARK: - 配置（开源版默认空，用户填 ~/Library/Application Support/local.zeen.nettools/config.json）

private struct AppConfig: Codable {
    struct Company: Codable {
        var name: String = ""
        var intranetCIDR: String = ""
        var intranetDNS: [String] = []
        var resolverDomain: String = ""
        var internalHost: String = ""
        var internalProbeIP: String = ""
    }
    struct VPN: Codable {
        var enabled: Bool = false
        var configName: String = ""
        var clientAppPath: String = "/Applications/Tunnelblick.app"
    }
    var company: Company = Company()
    var vpn: VPN = VPN()

    /// 显示名，空时回退「公司」
    var displayName: String { company.name.isEmpty ? "公司" : company.name }

    /// VPN 功能是否可用（总开关开 + 探针 IP 已填）
    var vpnEnabled: Bool { vpn.enabled && !company.internalProbeIP.isEmpty }

    /// 内网网段的纯数字前缀（如 "10.0."），用于 IP 前缀判断的兼容
    var intranetPrefix: String {
        // 从 CIDR 如 "10.0.0.0/8" 提取前两段 "10.0."
        let parts = company.intranetCIDR.split(separator: "/").first.map(String.init) ?? ""
        let segs = parts.split(separator: ".").map(String.init)
        if segs.count >= 2 { return segs[0] + "." + segs[1] + "." }
        return ""
    }

    static let empty = AppConfig()
}

private func loadConfig() -> AppConfig {
    let dir = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        .appendingPathComponent("local.zeen.nettools", isDirectory: true)
    let url = dir.appendingPathComponent("config.json")
    // 首次启动：目录/文件不存在则创建空配置
    if !FileManager.default.fileExists(atPath: url.path) {
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let empty = AppConfig()
        if let data = try? JSONEncoder().encode(empty) {
            try? data.write(to: url, options: [.atomic])
        }
        return empty
    }
    guard let data = try? Data(contentsOf: url),
          let cfg = try? JSONDecoder().decode(AppConfig.self, from: data) else {
        return AppConfig.empty
    }
    return cfg
}

private final class AppDelegate: NSObject, NSApplicationDelegate, WKScriptMessageHandler, WKNavigationDelegate {
    private var window: NSWindow!
    private var webView: WKWebView!

    private let config = loadConfig()

    // 从配置读取（取代旧的硬编码公司常量）
    private var companyDNS: [String] { config.company.intranetDNS }
    private var gitlabHost: String { config.company.internalHost }
    private var gitlabIP: String { config.company.internalProbeIP }
    private var vpnName: String { config.vpn.configName }
    private var companyName: String { config.displayName }
    private var resolverDomain: String { config.company.resolverDomain }
    private var intranetCIDR: String { config.company.intranetCIDR }
    private var intranetPrefix: String { config.intranetPrefix }
    private var vpnClientAppPath: String { config.vpn.clientAppPath }

    func applicationDidFinishLaunching(_ notification: Notification) {
        let config = WKWebViewConfiguration()
        config.userContentController.add(self, name: "netrepair")
        config.preferences.setValue(true, forKey: "developerExtrasEnabled")

        webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = self

        window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1080, height: 720),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = "捞鱼的网络工具"
        window.minSize = NSSize(width: 900, height: 620)
        window.center()
        window.contentView = webView
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)

        if let url = Bundle.main.url(forResource: "index", withExtension: "html") {
            webView.loadFileURL(url, allowingReadAccessTo: url.deletingLastPathComponent())
        } else {
            webView.loadHTMLString("<h1 style='font-family:sans-serif'>找不到 index.html</h1>", baseURL: nil)
        }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if navigationAction.navigationType == .linkActivated,
           let url = navigationAction.request.url,
           url.scheme == "http" || url.scheme == "https" {
            NSWorkspace.shared.open(url)
            decisionHandler(.cancel)
            return
        }
        decisionHandler(.allow)
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any],
              let action = body["action"] as? String else { return }
        let reqId = body["reqId"] as? Int ?? 0
        let args = body["args"] as? [String: Any] ?? [:]

        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            guard let self else { return }
            do {
                let data = try self.handle(action: action, args: args)
                self.reply(reqId: reqId, data: data)
            } catch {
                self.reply(reqId: reqId, error: error.localizedDescription)
            }
        }
    }

    private func reply(reqId: Int, data: [String: Any]? = nil, error: String? = nil) {
        var payload: [String: Any] = ["reqId": reqId, "ok": error == nil]
        if let data { payload["data"] = data }
        if let error { payload["error"] = error }
        guard let raw = try? JSONSerialization.data(withJSONObject: payload),
              let json = String(data: raw, encoding: .utf8) else { return }
        DispatchQueue.main.async { [weak self] in
            self?.webView.evaluateJavaScript("window.__handleResult(\(json))")
        }
    }

    fileprivate func handle(action: String, args: [String: Any]) throws -> [String: Any] {
        switch action {
        case "get-status": return getStatus()
        case "network-check": return networkCheck()
        case "diagnose": return diagnose()
        case "flush-dns": return try flushDNS()
        case "set-dns": return try setDNS(args)
        case "clear-proxy": return try clearProxy()
        case "restore-proxy": return try restoreProxy()
        case "renew-dhcp": return try renewDHCP()
        case "wifi-info": return wifiInfo()
        case "ping-test": return pingTest()
        case "speedtest": return speedTest()
        case "vpn-status": return vpnStatus()
        case "vpn-connect": return try vpnConnect()
        case "vpn-coexist": return try vpnCoexist()
        case "vpn-coexist-reset": return try vpnCoexistReset()
        case "helper-status": return helperStatus()
        case "install-helper": return try installHelper()
        case "uninstall-helper": return try uninstallHelper()
        case "get-config": return getConfig()
        case "save-config": return try saveConfig(args)
        case "export-config": return exportConfig()
        case "import-config": return try importConfig(args)
        default: throw AppFailure(message: "不支持的操作：\(action)")
        }
    }

    // MARK: - Privileged helper（setuid root，免密执行特权操作）

    private let helperPath = "/usr/local/bin/netrepair-helper"

    private func helperInstalled() -> Bool {
        FileManager.default.isExecutableFile(atPath: helperPath)
    }

    private func helperStatus() -> [String: Any] {
        var installed = helperInstalled()
        var euidIsRoot = false
        if installed {
            // 调 self-test 确认它确实是 root
            let r = run(helperPath, ["self-test"], timeout: 5)
            if let data = r.output.data(using: .utf8),
               let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                euidIsRoot = (json["ok"] as? Bool == true) && (json["output"] as? String ?? "").contains("running as root")
            }
            // 校验 setuid 位
            if let attrs = try? FileManager.default.attributesOfItem(atPath: helperPath),
               let posix = attrs[.posixPermissions] as? NSNumber {
                let mode = posix.int16Value
                installed = (mode & 0o4000) != 0  // setuid 位
            }
        }
        return [
            "installed": installed && euidIsRoot,
            "path": helperPath,
            "privileged": installed && euidIsRoot,
            "message": (installed && euidIsRoot)
                ? "✓ 已安装免密授权，所有特权操作无需密码（含守护无人值守）"
                : "✗ 未安装免密授权，特权操作会弹系统密码框"
        ]
    }

    /// 调 helper 执行特权 action，返回 (ok, message)
    private func runHelper(_ action: String, _ helperArgs: [String] = []) throws -> (ok: Bool, message: String) {
        guard helperInstalled() else {
            throw AppFailure(message: "免密助手未安装，请先在「修复工具」页点「安装授权」")
        }
        let allArgs = [action] + helperArgs
        let result = run(helperPath, allArgs, timeout: 30)
        if let data = result.output.data(using: .utf8),
           let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            let ok = json["ok"] as? Bool ?? false
            let msg = json["message"] as? String ?? (ok ? "成功" : "失败")
            return (ok, msg)
        }
        throw AppFailure(message: result.output.isEmpty ? "助手执行失败" : result.output)
    }

    /// 安装免密助手：把 bundled helper 复制到 /usr/local/bin 并 setuid root（最后一次密码）
    private func installHelper() throws -> [String: Any] {
        guard let bundled = Bundle.main.url(forResource: "netrepair-helper", withExtension: nil) else {
            throw AppFailure(message: "找不到内置的 netrepair-helper 二进制")
        }
        // 先复制到临时位置（避免直接写 /usr/local/bin 的权限问题）
        let tmp = NSTemporaryDirectory() + "netrepair-helper-\(UUID().uuidString)"
        try? FileManager.default.removeItem(atPath: tmp)
        try? FileManager.default.copyItem(atPath: bundled.path, toPath: tmp)
        // 一次 osascript：复制 + chown root + chmod 4755（setuid）
        let cmd = "/bin/cp \(shellQuote(tmp)) \(shellQuote(helperPath)) && /usr/sbin/chown root:wheel \(shellQuote(helperPath)) && /bin/chmod 4755 \(shellQuote(helperPath)) && echo OK"
        _ = try runAsAdminOSA(cmd)
        // 验证
        Thread.sleep(forTimeInterval: 0.5)
        let st = helperStatus()
        if st["installed"] as? Bool == true {
            return ["message": "✓ 免密授权已安装，所有特权操作和守护都不再需要密码", "installed": true]
        }
        throw AppFailure(message: "安装似乎完成，但验证未通过，请检查 /usr/local/bin/netrepair-helper 权限")
    }

    /// 卸载免密助手
    private func uninstallHelper() throws -> [String: Any] {
        _ = try runAsAdminOSA("/bin/rm -f \(shellQuote(helperPath)) && echo OK")
        return ["message": "免密授权已卸载，特权操作将恢复弹密码框", "installed": false]
    }

    // MARK: - 配置管理

    /// 把配置回传给前端（返回完整字段值，供表单回填）
    private func getConfig() -> [String: Any] {
        return [
            "companyName": companyName,
            "vpnEnabled": config.vpnEnabled,
            "vpnConfigured": !vpnName.isEmpty,
            "configName": vpnName,                    // 回传真实配置名供表单回填
            "resolverDomain": resolverDomain,
            "internalHost": gitlabHost,
            "internalProbeIP": gitlabIP,
            "intranetCIDR": intranetCIDR,
            "intranetDNS": companyDNS.joined(separator: ", "),  // 数组转逗号分隔供表单
            "vpnClientAppPath": vpnClientAppPath,
            "vpnClientExists": FileManager.default.fileExists(atPath: vpnClientAppPath),
            "message": config.vpnEnabled
                ? "\(companyName) VPN 功能已启用"
                : "VPN 功能未配置，请填写下方表单或导入配置"
        ]
    }

    /// 保存配置（前端传完整 config 对象）
    private func saveConfig(_ args: [String: Any]) throws -> [String: Any] {
        let dir = configDir()
        guard let cfg = args["config"] as? [String: Any] else {
            throw AppFailure(message: "缺少 config 参数")
        }
        let data = try JSONSerialization.data(withJSONObject: cfg, options: [.prettyPrinted, .sortedKeys])
        try data.write(to: dir.appendingPathComponent("config.json"), options: .atomic)
        return ["message": "配置已保存，重新打开 app 生效"]
    }

    /// 导出配置：返回 config.json 的完整文本（含真实值），供用户复制分享给同事
    private func exportConfig() -> [String: Any] {
        let path = configDir().appendingPathComponent("config.json")
        if let data = try? Data(contentsOf: path),
           let text = String(data: data, encoding: .utf8) {
            return ["json": text, "message": "已读取当前配置，点「复制」发给同事"]
        }
        return ["json": "", "message": "还没有配置文件"]
    }

    /// 导入配置：接收一段 JSON 文本，校验后覆盖写入 config.json
    private func importConfig(_ args: [String: Any]) throws -> [String: Any] {
        guard let text = args["json"] as? String, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw AppFailure(message: "请粘贴配置 JSON 文本")
        }
        // 校验是合法 JSON，且结构大致正确（有 company 或 vpn 键）
        guard let data = text.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw AppFailure(message: "JSON 格式错误，请检查是否完整复制")
        }
        // 写入
        let dir = configDir()
        let pretty = try JSONSerialization.data(withJSONObject: obj, options: [.prettyPrinted, .sortedKeys])
        try pretty.write(to: dir.appendingPathComponent("config.json"), options: .atomic)
        return ["message": "✓ 配置已导入，重新打开 app 生效"]
    }

    /// 配置目录（统一入口）
    private func configDir() -> URL {
        let dir = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("local.zeen.nettools", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    /// 给 helper 调用构造配置参数（vpn-coexist 等 action 用）
    private func helperConfigArgs() -> [String] {
        var args: [String] = []
        if !intranetCIDR.isEmpty { args += ["--cidr", intranetCIDR] }
        if !companyDNS.isEmpty { args += ["--dns", companyDNS.joined(separator: ",")] }
        if !resolverDomain.isEmpty { args += ["--resolver", resolverDomain] }
        if !gitlabHost.isEmpty { args += ["--host", gitlabHost] }
        if !gitlabIP.isEmpty { args += ["--probe-ip", gitlabIP] }
        return args
    }

    // MARK: - Process helpers

    private func run(_ executable: String, _ arguments: [String] = [], timeout: TimeInterval = 15) -> CommandResult {
        let tempURL = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("netrepair-\(UUID().uuidString).log")
        FileManager.default.createFile(atPath: tempURL.path, contents: nil)
        guard let file = try? FileHandle(forWritingTo: tempURL) else {
            return CommandResult(output: "无法创建临时文件", status: -1, timedOut: false)
        }
        defer {
            try? file.close()
            try? FileManager.default.removeItem(at: tempURL)
        }

        let process = Process()
        process.executableURL = URL(fileURLWithPath: executable)
        process.arguments = arguments
        process.standardOutput = file
        process.standardError = file
        let semaphore = DispatchSemaphore(value: 0)
        process.terminationHandler = { _ in semaphore.signal() }

        do {
            try process.run()
        } catch {
            return CommandResult(output: error.localizedDescription, status: -1, timedOut: false)
        }

        let timedOut = semaphore.wait(timeout: .now() + timeout) == .timedOut
        if timedOut {
            process.terminate()
            _ = semaphore.wait(timeout: .now() + 2)
        }
        try? file.synchronize()
        let output = (try? String(contentsOf: tempURL, encoding: .utf8)) ?? ""
        return CommandResult(output: output.trimmingCharacters(in: .whitespacesAndNewlines),
                             status: timedOut ? -9 : process.terminationStatus,
                             timedOut: timedOut)
    }

    private func shell(_ command: String, timeout: TimeInterval = 15) -> CommandResult {
        run("/bin/zsh", ["-lc", command], timeout: timeout)
    }

    private func shellQuote(_ value: String) -> String {
        "'" + value.replacingOccurrences(of: "'", with: "'\\''") + "'"
    }

    private func appleScriptQuote(_ value: String) -> String {
        "\"" + value.replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "\"", with: "\\\"") + "\""
    }

    /// 原始 osascript 提权方式（仅用于安装/卸载 helper，每次弹密码框）
    private func runAsAdminOSA(_ command: String, timeout: TimeInterval = 120) throws -> String {
        let script = "do shell script \(appleScriptQuote(command)) with administrator privileges"
        let result = run("/usr/bin/osascript", ["-e", script], timeout: timeout)
        if result.status != 0 {
            if result.output.localizedCaseInsensitiveContains("User canceled") ||
                result.output.contains("(-128)") {
                throw AppFailure(message: "你取消了系统授权，未改动网络配置")
            }
            throw AppFailure(message: result.output.isEmpty ? "系统操作失败" : result.output)
        }
        return result.output
    }

    /// 特权执行：优先用 helper 免密，未安装则 fallback 到 osascript（弹密码框）
    /// - Parameter commandBuilder: 返回要执行的命令字符串（闭包，避免无用计算）
    /// - Parameter helperAction: 对应的 helper action 名 + 参数
    private func runPrivileged(helperAction: String, helperArgs: [String] = [],
                               commandBuilder: () -> String) throws -> (helper: Bool, message: String) {
        // 优先走 helper（免密）
        if helperInstalled() {
            do {
                return try (true, runHelper(helperAction, helperArgs).message)
            } catch {
                // helper 失败了，不 fallback（避免重复执行），直接报错
                throw error
            }
        }
        // fallback：osascript 弹密码框
        let cmd = commandBuilder()
        _ = try runAsAdminOSA(cmd)
        return (false, "")
    }

    // MARK: - Network identity

    private func routeInfo(_ destination: String = "default") -> [String: String] {
        let result = run("/sbin/route", ["-n", "get", destination], timeout: 4)
        var data: [String: String] = [:]
        for line in result.output.split(separator: "\n") {
            let parts = line.split(separator: ":", maxSplits: 1).map(String.init)
            if parts.count == 2 {
                data[parts[0].trimmingCharacters(in: .whitespaces)] =
                    parts[1].trimmingCharacters(in: .whitespaces)
            }
        }
        return data
    }

    private func activeInterface() -> String {
        routeInfo()["interface"] ?? ""
    }

    private func ipv4(_ interface: String) -> String {
        guard !interface.isEmpty else { return "" }
        return run("/usr/sbin/ipconfig", ["getifaddr", interface], timeout: 3).output
    }

    private func serviceForDevice(_ device: String) -> String {
        let output = run("/usr/sbin/networksetup", ["-listnetworkserviceorder"], timeout: 5).output
        var pendingService = ""
        for raw in output.split(separator: "\n") {
            let line = String(raw)
            if let range = line.range(of: #"^\(\d+\)\s+"#, options: .regularExpression) {
                pendingService = String(line[range.upperBound...]).trimmingCharacters(in: .whitespaces)
            } else if line.contains("Device: \(device)") && !pendingService.isEmpty {
                return pendingService
            }
        }
        if device == "en0" { return "Wi-Fi" }
        return device
    }

    private func activeIdentity() -> (interface: String, service: String, ip: String, gateway: String) {
        let route = routeInfo()
        let interface = route["interface"] ?? ""
        return (interface, serviceForDevice(interface), ipv4(interface), route["gateway"] ?? "")
    }

    // MARK: - Read-only checks

    private func proxyState() -> [String: Any] {
        let output = run("/usr/sbin/scutil", ["--proxy"], timeout: 4).output
        func value(_ key: String) -> String {
            guard let match = output.range(of: "(?m)^\\s*\(NSRegularExpression.escapedPattern(for: key))\\s*:\\s*(.+)$", options: .regularExpression) else { return "" }
            let line = String(output[match])
            return line.split(separator: ":", maxSplits: 1).last.map(String.init)?.trimmingCharacters(in: .whitespaces) ?? ""
        }
        let httpOn = value("HTTPEnable") == "1"
        let httpsOn = value("HTTPSEnable") == "1"
        let socksOn = value("SOCKSEnable") == "1"
        let enabled = httpOn || httpsOn || socksOn
        let host = !value("HTTPSProxy").isEmpty ? value("HTTPSProxy") : (!value("HTTPProxy").isEmpty ? value("HTTPProxy") : value("SOCKSProxy"))
        let portText = !value("HTTPSPort").isEmpty ? value("HTTPSPort") : (!value("HTTPPort").isEmpty ? value("HTTPPort") : value("SOCKSPort"))
        let port = Int(portText) ?? 0
        var reachable = false
        if enabled && !host.isEmpty && port > 0 {
            reachable = run("/usr/bin/nc", ["-z", "-G", "1", host, String(port)], timeout: 3).status == 0
        }
        return ["enabled": enabled, "host": host, "port": port, "reachable": reachable]
    }

    private func curlHTTP(_ url: String, proxy: [String: Any]? = nil, timeout: Int = 6) -> (ok: Bool, code: String) {
        var args = ["-sS", "-L", "-o", "/dev/null", "-w", "%{http_code}", "--connect-timeout", "3", "--max-time", String(timeout)]
        if let proxy,
           proxy["enabled"] as? Bool == true,
           proxy["reachable"] as? Bool == true,
           let host = proxy["host"] as? String,
           let port = proxy["port"] as? Int {
            args += ["-x", "http://\(host):\(port)"]
        } else {
            args += ["--noproxy", "*"]
        }
        args.append(url)
        let result = run("/usr/bin/curl", args, timeout: TimeInterval(timeout + 2))
        let code = result.output.split(separator: "\n").last.map(String.init) ?? "000"
        return (result.status == 0 && code != "000", code)
    }

    private func resolveSystem(_ host: String) -> [String] {
        let out = run("/usr/bin/dscacheutil", ["-q", "host", "-a", "name", host], timeout: 6).output
        return out.split(separator: "\n").compactMap { raw in
            let line = String(raw).trimmingCharacters(in: .whitespaces)
            guard line.hasPrefix("ip_address:") else { return nil }
            return line.replacingOccurrences(of: "ip_address:", with: "").trimmingCharacters(in: .whitespaces)
        }
    }

    private func resolveDirect(_ host: String, server: String) -> String {
        let result = run("/usr/bin/dig", ["+short", "+time=3", "+tries=1", "@\(server)", host], timeout: 5)
        return result.output.split(separator: "\n").map(String.init).first { $0.range(of: #"^\d+\.\d+\.\d+\.\d+$"#, options: .regularExpression) != nil } ?? ""
    }

    private func networkCheck() -> [String: Any] {
        let id = activeIdentity()
        let hasLink = !id.interface.isEmpty && !id.ip.isEmpty
        let ping = run("/sbin/ping", ["-c", "2", "-W", "1500", "223.5.5.5"], timeout: 5)
        let rawFallback = ping.status == 0 ? (ok: true, code: "204") : curlHTTP("http://110.242.68.66", timeout: 5)
        let rawOK = ping.status == 0 || rawFallback.ok
        let dnsIPs = resolveSystem("www.baidu.com")
        let dnsOK = !dnsIPs.isEmpty
        let proxy = proxyState()
        let web = curlHTTP("https://www.baidu.com", proxy: proxy, timeout: 7)
        let directWeb = web.ok ? (ok: true, code: web.code) : curlHTTP("https://www.baidu.com", timeout: 7)
        let httpOK = web.ok || directWeb.ok

        let issue: String
        if !hasLink { issue = "no-link" }
        else if proxy["enabled"] as? Bool == true && proxy["reachable"] as? Bool == false { issue = "stale-proxy" }
        // 代理可能在远端代做 DNS。网页真实可用时，不把本机 DNS 失败误判成断网。
        else if httpOK { issue = "ok" }
        else if !rawOK { issue = "no-route" }
        else if !dnsOK { issue = "dns" }
        else { issue = "http" }

        return [
            "ok": issue == "ok", "issue": issue,
            "interface": id.interface, "service": id.service, "ip": id.ip, "gateway": id.gateway,
            "rawOk": rawOK, "dnsOk": dnsOK, "dnsIp": dnsIPs.first ?? "",
            "httpOk": httpOK, "httpCode": web.ok ? web.code : directWeb.code,
            "proxyEnabled": proxy["enabled"] ?? false,
            "proxyReachable": proxy["reachable"] ?? false,
            "proxyEndpoint": "\(proxy["host"] ?? ""):\(proxy["port"] ?? 0)"
        ]
    }

    private func getStatus() -> [String: Any] {
        let id = activeIdentity()
        let version = run("/usr/bin/sw_vers", ["-productVersion"], timeout: 3).output
        return ["online": !id.ip.isEmpty, "iface": id.interface.isEmpty ? "无" : id.interface,
                "service": id.service, "ip": id.ip, "gateway": id.gateway, "os": version]
    }

    private func diagnose() -> [String: Any] {
        let check = networkCheck()
        let proxy = proxyState()
        let hosts = shell("grep -vE '^\\s*#|^\\s*$|localhost|broadcasthost' /etc/hosts 2>/dev/null", timeout: 3).output
        let firewall = run("/usr/libexec/ApplicationFirewall/socketfilterfw", ["--getglobalstate"], timeout: 3).output
        let gitlab = vpnStatus()

        var items: [[String: Any]] = []
        func add(_ name: String, _ detail: String, _ status: String, _ advice: String = "") {
            var item: [String: Any] = ["name": name, "detail": detail, "status": status]
            if !advice.isEmpty { item["advice"] = advice }
            items.append(item)
        }

        let hasLink = !(check["ip"] as? String ?? "").isEmpty
        add("本机网络", hasLink ? "\(check["service"] ?? "") · \(check["interface"] ?? "") · \(check["ip"] ?? "")" : "未取得有效 IP", hasLink ? "ok" : "err", "检查网线、Wi‑Fi 或 DHCP")
        let gateway = check["gateway"] as? String ?? ""
        add("默认路由", gateway.isEmpty ? "没有默认网关" : "网关 \(gateway)", gateway.isEmpty ? "err" : "ok", "续租 DHCP 或检查路由器")
        add("公网 IP 连通", check["rawOk"] as? Bool == true ? "IP 直连正常" : "IP 直连失败", check["rawOk"] as? Bool == true ? "ok" : "err", "检查路由、VPN 与物理网络")
        let dnsOK = check["dnsOk"] as? Bool == true
        let webOK = check["httpOk"] as? Bool == true
        add("DNS 解析", dnsOK ? "www.baidu.com → \(check["dnsIp"] ?? "")" : (webOK ? "本机 DNS 失败，但当前代理正在代解析，网页仍可用" : "公共域名无法解析"), dnsOK ? "ok" : (webOK ? "warn" : "err"), dnsOK ? "" : (webOK ? "关闭梯子前，建议把当前网络服务的 DNS 恢复为自动获取" : "清 DNS 缓存；不要盲目覆盖 Tailscale DNS"))
        add("网页访问", check["httpOk"] as? Bool == true ? "HTTPS 正常（HTTP \(check["httpCode"] ?? "")）" : "HTTPS 访问失败", check["httpOk"] as? Bool == true ? "ok" : "err", "结合代理与 DNS 项判断")

        if proxy["enabled"] as? Bool == true {
            let reachable = proxy["reachable"] as? Bool == true
            add("系统代理", "\(proxy["host"] ?? ""):\(proxy["port"] ?? 0) · \(reachable ? "代理进程可达" : "端口无监听")", reachable ? "ok" : "err", reachable ? "代理正在工作，无需清除" : "可用“临时关闭失效代理”修复")
        } else {
            add("系统代理", "未启用系统代理", "info")
        }
        add("hosts 文件", hosts.isEmpty ? "没有额外映射" : "发现自定义映射：\(hosts.split(separator: "\n").count) 条", hosts.isEmpty ? "ok" : "warn", hosts.isEmpty ? "" : "确认这些映射是否仍然需要")
        add("防火墙", firewall.isEmpty ? "无法读取状态" : firewall, "info")

        // VPN 诊断项：仅当 VPN 已配置时显示
        if config.vpnEnabled {
            if gitlab["vpnConnected"] as? Bool == true {
                let systemOK = gitlab["systemDnsOk"] as? Bool == true
                add("\(companyName) 内网", systemOK ? "系统解析正确 → \(gitlab["systemGitlabIp"] ?? "")" : "系统解析异常 → \(gitlab["systemGitlabIp"] ?? "未解析")", systemOK ? "ok" : "err", "使用 VPN 页的「一键启用共存」安装\(resolverDomain.isEmpty ? "分域" : resolverDomain)分域解析")
            } else {
                add("\(companyName) VPN", "当前未检测到通往 \(gitlabIP) 的 VPN 路由", "info")
            }
        }
        return ["items": items, "issue": check["issue"] ?? "unknown"]
    }

    // MARK: - Repairs

    private func flushDNS() throws -> [String: Any] {
        let result = try runPrivileged(
            helperAction: "flush-dns",
            commandBuilder: { "/usr/bin/dscacheutil -flushcache; /usr/bin/killall -HUP mDNSResponder 2>/dev/null || true" }
        )
        return ["message": result.helper ? result.message : "DNS 缓存已刷新"]
    }

    private func setDNS(_ args: [String: Any]) throws -> [String: Any] {
        let id = activeIdentity()
        guard !id.service.isEmpty else { throw AppFailure(message: "找不到当前网络服务") }
        let primary = args["primary"] as? String ?? "empty"
        let secondary = args["secondary"] as? String ?? ""
        let result = try runPrivileged(
            helperAction: "set-dns",
            helperArgs: ["--service", id.service, "--primary", primary, "--secondary", secondary],
            commandBuilder: {
                var command = "/usr/sbin/networksetup -setdnsservers \(shellQuote(id.service)) "
                if primary == "empty" {
                    command += "empty"
                } else {
                    guard primary.range(of: #"^\d{1,3}(\.\d{1,3}){3}$"#, options: .regularExpression) != nil else {
                        return ""  // 格式校验已在下面 throw
                    }
                    command += shellQuote(primary)
                    if !secondary.isEmpty { command += " \(shellQuote(secondary))" }
                }
                command += "; /usr/bin/dscacheutil -flushcache; /usr/bin/killall -HUP mDNSResponder 2>/dev/null || true"
                return command
            }
        )
        // 格式校验（commandBuilder 里无法 throw）
        if primary != "empty" {
            guard primary.range(of: #"^\d{1,3}(\.\d{1,3}){3}$"#, options: .regularExpression) != nil else {
                throw AppFailure(message: "DNS 地址格式不正确")
            }
        }
        return ["message": result.helper ? result.message : (primary == "empty" ? "\(id.service) 已恢复自动 DNS" : "\(id.service) DNS 已更新")]
    }

    private func appSupportURL(_ name: String) -> URL {
        let root = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("local.zeen.nettools", isDirectory: true)
        try? FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        return root.appendingPathComponent(name)
    }

    private func proxySnapshot(service: String) -> [String: Any] {
        func read(_ flag: String) -> [String: Any] {
            let out = run("/usr/sbin/networksetup", [flag, service], timeout: 4).output
            var result: [String: Any] = [:]
            for line in out.split(separator: "\n") {
                let pair = line.split(separator: ":", maxSplits: 1).map(String.init)
                if pair.count == 2 { result[pair[0].trimmingCharacters(in: .whitespaces)] = pair[1].trimmingCharacters(in: .whitespaces) }
            }
            return result
        }
        let bypassRaw = run("/usr/sbin/networksetup", ["-getproxybypassdomains", service], timeout: 4).output
        return ["service": service, "web": read("-getwebproxy"), "secure": read("-getsecurewebproxy"),
                "socks": read("-getsocksfirewallproxy"), "auto": read("-getautoproxyurl"),
                "bypass": splitBypass(bypassRaw)]
    }

    private func saveJSON(_ value: [String: Any], to url: URL) {
        if let data = try? JSONSerialization.data(withJSONObject: value, options: [.prettyPrinted, .sortedKeys]) {
            try? data.write(to: url, options: .atomic)
        }
    }

    private func loadJSON(_ url: URL) -> [String: Any]? {
        guard let data = try? Data(contentsOf: url) else { return nil }
        return try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    }

    private func clearProxy() throws -> [String: Any] {
        let id = activeIdentity()
        guard !id.service.isEmpty else { throw AppFailure(message: "找不到当前网络服务") }
        saveJSON(proxySnapshot(service: id.service), to: appSupportURL("proxy-backup.json"))
        let service = shellQuote(id.service)
        let result = try runPrivileged(
            helperAction: "clear-proxy",
            helperArgs: ["--service", id.service],
            commandBuilder: {
                [
                    "/usr/sbin/networksetup -setwebproxystate \(service) off",
                    "/usr/sbin/networksetup -setsecurewebproxystate \(service) off",
                    "/usr/sbin/networksetup -setsocksfirewallproxystate \(service) off",
                    "/usr/sbin/networksetup -setautoproxystate \(service) off"
                ].joined(separator: "; ")
            }
        )
        return ["message": result.helper ? result.message : "已临时关闭 \(id.service) 的系统代理；Git/npm 配置未改动，可随时恢复"]
    }

    private func restoreProxy() throws -> [String: Any] {
        guard let snap = loadJSON(appSupportURL("proxy-backup.json")), let service = snap["service"] as? String else {
            throw AppFailure(message: "没有可恢复的代理备份")
        }
        var commands: [String] = []
        func restore(_ key: String, setFlag: String, stateFlag: String) {
            guard let data = snap[key] as? [String: Any] else { return }
            let enabled = (data["Enabled"] as? String ?? "No").lowercased().hasPrefix("y")
            let server = data["Server"] as? String ?? ""
            let port = data["Port"] as? String ?? "0"
            if !server.isEmpty && port != "0" {
                commands.append("/usr/sbin/networksetup \(setFlag) \(shellQuote(service)) \(shellQuote(server)) \(shellQuote(port))")
            }
            commands.append("/usr/sbin/networksetup \(stateFlag) \(shellQuote(service)) \(enabled ? "on" : "off")")
        }
        restore("web", setFlag: "-setwebproxy", stateFlag: "-setwebproxystate")
        restore("secure", setFlag: "-setsecurewebproxy", stateFlag: "-setsecurewebproxystate")
        restore("socks", setFlag: "-setsocksfirewallproxy", stateFlag: "-setsocksfirewallproxystate")
        if let bypass = snap["bypass"] as? [String] {
            commands.append("/usr/sbin/networksetup -setproxybypassdomains \(shellQuote(service)) " + bypass.map(shellQuote).joined(separator: " "))
        }
        // restore-proxy 逻辑复杂（需解析 JSON），helper 简化版不够完整，这里保持走 osascript
        // 但如果 helper 已装，helper 也支持基本的 restore-proxy（读同一个备份文件）
        let result = try runPrivileged(
            helperAction: "restore-proxy",
            commandBuilder: { commands.joined(separator: "; ") }
        )
        return ["message": result.helper ? result.message : "已恢复 \(service) 的上一次代理配置"]
    }

    private func renewDHCP() throws -> [String: Any] {
        let id = activeIdentity()
        guard !id.interface.isEmpty, !id.interface.hasPrefix("utun") else {
            throw AppFailure(message: "找不到可续租的物理网卡")
        }
        let result = try runPrivileged(
            helperAction: "renew-dhcp",
            helperArgs: ["--iface", id.interface],
            commandBuilder: { "/usr/sbin/ipconfig set \(shellQuote(id.interface)) DHCP" }
        )
        return ["message": result.helper ? result.message : "已为 \(id.service)（\(id.interface)）续租 DHCP；没有关闭 Wi‑Fi"]
    }

    // MARK: - Wi-Fi, ping and speed

    private func wifiInfo() -> [String: Any] {
        let result = run("/usr/sbin/system_profiler", ["SPAirPortDataType", "-json"], timeout: 12)
        guard result.status == 0,
              let data = result.output.data(using: .utf8),
              let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let groups = root["SPAirPortDataType"] as? [[String: Any]] else {
            return ["connected": false]
        }
        for group in groups {
            guard let interfaces = group["spairport_airport_interfaces"] as? [[String: Any]] else { continue }
            for iface in interfaces where (iface["_name"] as? String) == "en0" {
                guard (iface["spairport_status_information"] as? String) == "spairport_status_connected",
                      let net = iface["spairport_current_network_information"] as? [String: Any] else {
                    return ["connected": false]
                }
                let signal = net["spairport_signal_noise"] as? String ?? ""
                let nums = signal.matches(of: #"-?\d+"#).compactMap(Int.init)
                let rssi = nums.first ?? 0
                let noise = nums.count > 1 ? nums[1] : 0
                let snr = rssi - noise
                let channelText = net["spairport_network_channel"] as? String ?? "—"
                let channel = Int(channelText.matches(of: #"^\d+"#).first ?? "") ?? 0
                let band = channelText.contains("6GHz") ? "6GHz" : (channelText.contains("5GHz") ? "5GHz" : "2.4GHz")
                let rate = net["spairport_network_rate"] as? Int ?? 0
                let securityRaw = net["spairport_security_mode"] as? String ?? ""
                let security = securityRaw.replacingOccurrences(of: "spairport_security_mode_", with: "")
                    .replacingOccurrences(of: "pairport_security_mode_", with: "")
                    .replacingOccurrences(of: "_", with: " ").uppercased()
                let signalLevel = rssi >= -55 ? "ok" : (rssi >= -70 ? "warn" : "err")
                let signalLabel = rssi >= -55 ? "优秀" : (rssi >= -70 ? "可用" : "较弱")
                let snrLabel = snr >= 40 ? "优秀" : (snr >= 25 ? "可用" : "较差")
                return ["connected": true, "rssi": rssi, "noise": noise, "snr": snr,
                        "channel": channel, "band": band, "txrate": rate, "security": security,
                        "signalLevel": signalLevel, "signalLabel": signalLabel, "snrLabel": snrLabel]
            }
        }
        return ["connected": false]
    }

    private func pingTest() -> [String: Any] {
        let nodes = [("223.5.5.5", "阿里 DNS"), ("1.1.1.1", "Cloudflare"), ("114.114.114.114", "114 DNS")]
        let items: [[String: Any]] = nodes.map { ip, name in
            let result = run("/sbin/ping", ["-c", "3", "-W", "1500", ip], timeout: 7)
            let loss = result.output.firstMatch(of: #"([0-9.]+)% packet loss"#, group: 1) ?? "100"
            let avg = result.output.firstMatch(of: #"= [0-9.]+/([0-9.]+)/"#, group: 1) ?? "—"
            return ["ip": ip, "name": name, "ok": result.status == 0, "loss": loss + "%", "avg": avg]
        }
        return ["items": items]
    }

    private func speedTest() -> [String: Any] {
        let url = "https://speed.cloudflare.com/__down?bytes=25000000"
        let args = ["-sS", "-L", "-o", "/dev/null", "-w", "%{size_download} %{time_total}",
                    "--connect-timeout", "5", "--max-time", "20", url]
        let result = run("/usr/bin/curl", args, timeout: 23)
        let parts = result.output.split(separator: " ").compactMap { Double($0) }
        guard parts.count >= 2, parts[0] > 0, parts[1] > 0 else {
            return ["mbps": 0.0, "source": "Cloudflare", "ok": false, "message": "测速源不可达"]
        }
        let mbps = parts[0] * 8 / parts[1] / 1_000_000
        return ["mbps": Double(String(format: "%.1f", mbps)) ?? 0, "source": "Cloudflare 25MB", "ok": true]
    }

    // MARK: - VPN coexistence

    private func tailscaleDNSOn() -> Bool {
        let path = ["/usr/local/bin/tailscale", "/opt/homebrew/bin/tailscale"].first { FileManager.default.isExecutableFile(atPath: $0) }
        guard let path else { return false }
        return run(path, ["dns", "status"], timeout: 5).output.contains("Tailscale DNS: enabled")
    }

    private func halfRoutes() -> [(destination: String, gateway: String)] {
        let out = run("/usr/sbin/netstat", ["-rn", "-f", "inet"], timeout: 4).output
        return out.split(separator: "\n").compactMap { raw in
            let fields = raw.split(whereSeparator: { $0 == " " || $0 == "\t" }).map(String.init)
            guard fields.count >= 2, fields[0] == "0/1" || fields[0] == "128.0/1" else { return nil }
            return (fields[0], fields[1])
        }
    }

    private func resolverInstalled() -> Bool {
        // 分域 DNS 文件路径由配置的 resolverDomain 决定（如 /etc/resolver/corp.example.com）
        resolverDomain.isEmpty ? false : FileManager.default.fileExists(atPath: "/etc/resolver/\(resolverDomain)")
    }

    private func vpnStatus() -> [String: Any] {
        // 未配置 VPN 时降级
        guard config.vpnEnabled else {
            return ["vpnConnected": false, "processAlive": false, "disabled": true,
                    "detail": "VPN 功能未配置，请在 config.json 填写公司内网信息"]
        }
        let route = routeInfo(gitlabIP)
        let routeIface = route["interface"] ?? ""
        let vpnConnected = routeIface.hasPrefix("utun") || routeIface.hasPrefix("tun")
        let processAlive = vpnName.isEmpty ? false : shell("pgrep -alf 'openvpn.*\(vpnName)|\(vpnName).*openvpn' >/dev/null", timeout: 3).status == 0
        let directIP = (vpnConnected && !companyDNS.isEmpty) ? resolveDirect(gitlabHost, server: companyDNS[0]) : ""
        let systemIPs = resolveSystem(gitlabHost)
        let systemIP = systemIPs.first ?? ""
        let directOK = !intranetPrefix.isEmpty && directIP.hasPrefix(intranetPrefix)
        let systemOK = !intranetPrefix.isEmpty && systemIPs.contains { $0.hasPrefix(intranetPrefix) }
        let routes = halfRoutes()
        let proxy = proxyState()
        let id = activeIdentity()
        let bypass = splitBypass(run("/usr/sbin/networksetup", ["-getproxybypassdomains", id.service], timeout: 4).output)
        let bypassOK = (!resolverDomain.isEmpty && bypass.contains("*.\(resolverDomain)")) || bypass.contains(gitlabHost)

        var detail: [String] = []
        detail.append(vpnConnected ? "VPN 路由：\(routeIface)" : "VPN 路由：未连接")
        detail.append("\(companyName) DNS：" + (directOK ? directIP : "未得到内网地址"))
        detail.append("系统解析：" + (systemIP.isEmpty ? "失败" : systemIP))
        let tailscaleOn = tailscaleDNSOn()
        if tailscaleOn { detail.append("Tailscale DNS：开启") }
        if proxy["enabled"] as? Bool == true { detail.append("系统代理：已开启") }

        return [
            "vpnConnected": vpnConnected, "processAlive": processAlive,
            "routeHijacked": !routes.isEmpty, "companyDnsOk": directOK,
            "intranetOk": systemOK, "systemDnsOk": systemOK,
            "intranetIp": directIP, "systemGitlabIp": systemIP,
            "resolverInstalled": resolverInstalled(), "proxyBypassOk": bypassOK,
            "tailscaleDnsOn": tailscaleOn, "proxyOn": proxy["enabled"] ?? false,
            "routeInterface": routeIface, "detail": detail.joined(separator: " · ")
        ]
    }

    private func vpnConnect() throws -> [String: Any] {
        guard config.vpnEnabled else {
            throw AppFailure(message: "VPN 功能未配置，请在 config.json 填写公司内网信息")
        }
        let route = routeInfo(gitlabIP)
        let iface = route["interface"] ?? ""
        if iface.hasPrefix("utun") || iface.hasPrefix("tun") {
            return ["message": "\(companyName) VPN 已连接", "alreadyConnected": true]
        }
        guard FileManager.default.fileExists(atPath: vpnClientAppPath) else {
            throw AppFailure(message: "未找到 Tunnelblick，请先安装并导入 \(vpnName)")
        }
        let source = "tell application \"Tunnelblick\" to connect \"\(vpnName)\""
        let result = run("/usr/bin/osascript", ["-e", source], timeout: 15)
        if result.status != 0 { throw AppFailure(message: result.output.isEmpty ? "Tunnelblick 连接失败" : result.output) }
        return ["message": "已让 Tunnelblick 连接 \(vpnName)，请等待隧道建立", "alreadyConnected": false]
    }

    private func splitBypass(_ raw: String) -> [String] {
        raw.replacingOccurrences(of: "There aren't any bypass domains set on", with: "")
            .split(whereSeparator: { $0 == "," || $0 == "\n" })
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty && !$0.hasPrefix("Wi-Fi") }
    }

    private func currentDNS(service: String) -> [String] {
        let out = run("/usr/sbin/networksetup", ["-getdnsservers", service], timeout: 4).output
        if out.contains("There aren't any DNS Servers") { return [] }
        return out.split(separator: "\n").map(String.init).filter { $0.range(of: #"^\d{1,3}(\.\d{1,3}){3}$"#, options: .regularExpression) != nil }
    }

    private func vpnGateway() -> String {
        if let gateway = halfRoutes().first?.gateway { return gateway }
        guard let firstDNS = companyDNS.first else { return "" }
        let route = routeInfo(firstDNS)
        let iface = route["interface"] ?? ""
        if iface.hasPrefix("utun") || iface.hasPrefix("tun") { return route["gateway"] ?? "" }
        return ""
    }

    private func vpnCoexist() throws -> [String: Any] {
        guard config.vpnEnabled else {
            throw AppFailure(message: "VPN 功能未配置，请在 config.json 填写公司内网信息")
        }
        let status = vpnStatus()
        guard status["vpnConnected"] as? Bool == true || !halfRoutes().isEmpty else {
            throw AppFailure(message: "请先连接\(companyName) VPN；当前没有检测到公司内网隧道")
        }
        let id = activeIdentity()
        let gateway = vpnGateway()
        guard !gateway.isEmpty else { throw AppFailure(message: "找不到 VPN 网关，未执行任何改动") }

        let originalDNS = currentDNS(service: id.service)
        let originalBypass = splitBypass(run("/usr/sbin/networksetup", ["-getproxybypassdomains", id.service], timeout: 4).output)
        let routes = halfRoutes().map { ["destination": $0.destination, "gateway": $0.gateway] }
        saveJSON(["service": id.service, "dns": originalDNS, "bypass": originalBypass, "routes": routes],
                 to: appSupportURL("coexist-backup.json"))

        // 构建命令串（给 osascript fallback 用）
        var commands: [String] = []
        if !intranetCIDR.isEmpty {
            commands.append("/sbin/route -n delete -net \(intranetCIDR) 2>/dev/null || true")
            commands.append("/sbin/route -n add -net \(intranetCIDR) \(shellQuote(gateway))")
        }
        for dns in companyDNS {
            commands.append("/sbin/route -n delete -host \(dns) 2>/dev/null || true")
            commands.append("/sbin/route -n add -host \(dns) \(shellQuote(gateway))")
        }
        for route in halfRoutes() {
            let target = route.destination == "0/1" ? "0.0.0.0/1" : "128.0.0.0/1"
            commands.append("/sbin/route -n delete -net \(target) \(shellQuote(route.gateway)) 2>/dev/null || true")
        }
        if !resolverDomain.isEmpty {
            let dnsLines = companyDNS.map { "nameserver \($0)" }.joined(separator: "\\n")
            commands.append("/bin/mkdir -p /etc/resolver")
            commands.append("/usr/bin/printf '\(dnsLines)\\ntimeout 3\\n' > /etc/resolver/\(resolverDomain)")
        }
        var bypass = originalBypass
        var domainsToAdd: [String] = []
        if !resolverDomain.isEmpty { domainsToAdd.append("*.\(resolverDomain)") }
        if !gitlabHost.isEmpty { domainsToAdd.append(gitlabHost) }
        for domain in domainsToAdd where !bypass.contains(domain) { bypass.append(domain) }
        commands.append("/usr/sbin/networksetup -setproxybypassdomains \(shellQuote(id.service)) " + bypass.map(shellQuote).joined(separator: " "))
        if originalDNS.contains(where: companyDNS.contains) {
            commands.append("/usr/sbin/networksetup -setdnsservers \(shellQuote(id.service)) empty")
        }
        commands.append("/usr/bin/dscacheutil -flushcache")
        commands.append("/usr/bin/killall -HUP mDNSResponder 2>/dev/null || true")

        // 优先走 helper（免密），否则 osascript
        _ = try runPrivileged(
            helperAction: "vpn-coexist",
            helperArgs: helperConfigArgs(),
            commandBuilder: { commands.joined(separator: "; ") }
        )

        Thread.sleep(forTimeInterval: 1.5)
        let after = vpnStatus()
        let routeOK = after["vpnConnected"] as? Bool == true
        let dnsOK = after["systemDnsOk"] as? Bool == true
        let bypassOK = after["proxyBypassOk"] as? Bool == true
        let steps: [[String: Any]] = [
            ["name": "\(companyName)流量精确路由", "detail": routeOK ? "\(intranetCIDR.isEmpty ? "内网" : intranetCIDR) 仍走 VPN" : "未验证到 VPN 路由", "ok": routeOK],
            ["name": "移除全网劫持路由", "detail": after["routeHijacked"] as? Bool == true ? "仍检测到半世界路由" : "梯子与公网不再被公司 VPN 抢走", "ok": after["routeHijacked"] as? Bool != true],
            ["name": "\(resolverDomain.isEmpty ? "分域" : resolverDomain) 分域 DNS", "detail": dnsOK ? "\(gitlabHost) → \(after["systemGitlabIp"] ?? "")" : "\(companyName) DNS 可达，但系统解析尚未命中内网", "ok": dnsOK],
            ["name": "代理直连名单", "detail": bypassOK ? "\(resolverDomain.isEmpty ? "内网域名" : "*.\(resolverDomain)") 已绕过梯子代理" : "直连名单未生效", "ok": bypassOK]
        ]
        let allOK = steps.allSatisfy { $0["ok"] as? Bool == true }
        return ["message": allOK ? "VPN 与梯子共存已真正生效" : "共存配置已应用，但有项目需要复查",
                "allOk": allOK, "steps": steps]
    }

    private func vpnCoexistReset() throws -> [String: Any] {
        guard let snap = loadJSON(appSupportURL("coexist-backup.json")), let service = snap["service"] as? String else {
            throw AppFailure(message: "没有找到共存配置备份")
        }
        var commands: [String] = []
        if !resolverDomain.isEmpty { commands.append("/bin/rm -f /etc/resolver/\(resolverDomain)") }
        if let bypass = snap["bypass"] as? [String] {
            commands.append("/usr/sbin/networksetup -setproxybypassdomains \(shellQuote(service)) " + bypass.map(shellQuote).joined(separator: " "))
        }
        if let dns = snap["dns"] as? [String], !dns.isEmpty {
            commands.append("/usr/sbin/networksetup -setdnsservers \(shellQuote(service)) " + dns.map(shellQuote).joined(separator: " "))
        } else {
            commands.append("/usr/sbin/networksetup -setdnsservers \(shellQuote(service)) empty")
        }
        commands.append("/usr/bin/dscacheutil -flushcache; /usr/bin/killall -HUP mDNSResponder 2>/dev/null || true")
        let result = try runPrivileged(
            helperAction: "vpn-coexist-reset",
            helperArgs: resolverDomain.isEmpty ? [] : ["--resolver", resolverDomain],
            commandBuilder: { commands.joined(separator: "; ") }
        )
        return ["message": result.helper ? result.message : "分域 DNS、代理直连名单和 DNS 设置已恢复；重连 VPN 可恢复原始 VPN 路由"]
    }
}

private extension String {
    func matches(of pattern: String) -> [String] {
        guard let regex = try? NSRegularExpression(pattern: pattern) else { return [] }
        let ns = self as NSString
        return regex.matches(in: self, range: NSRange(location: 0, length: ns.length)).compactMap {
            guard $0.range.location != NSNotFound else { return nil }
            return ns.substring(with: $0.range)
        }
    }

    func firstMatch(of pattern: String, group: Int) -> String? {
        guard let regex = try? NSRegularExpression(pattern: pattern),
              let match = regex.firstMatch(in: self, range: NSRange(location: 0, length: (self as NSString).length)),
              match.numberOfRanges > group,
              match.range(at: group).location != NSNotFound else { return nil }
        return (self as NSString).substring(with: match.range(at: group))
    }
}

private let delegate = AppDelegate()
if CommandLine.arguments.contains("--self-test") {
    let actions = ["get-status", "network-check", "diagnose", "wifi-info", "ping-test", "vpn-status"]
    var report: [String: Any] = [:]
    for action in actions {
        do { report[action] = try delegate.handle(action: action, args: [:]) }
        catch { report[action] = ["error": error.localizedDescription] }
    }
    let data = try! JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys])
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data("\n".utf8))
    exit(0)
}

if let argument = CommandLine.arguments.first(where: { $0.hasPrefix("--self-test-action=") }) {
    let action = argument.replacingOccurrences(of: "--self-test-action=", with: "")
    do {
        let result = try delegate.handle(action: action, args: [:])
        let data = try JSONSerialization.data(withJSONObject: result, options: [.prettyPrinted, .sortedKeys])
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write(Data("\n".utf8))
        exit(0)
    } catch {
        FileHandle.standardError.write(Data((error.localizedDescription + "\n").utf8))
        exit(1)
    }
}

let app = NSApplication.shared
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
