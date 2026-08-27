//
//  NetRepairHelper.swift
//  捞鱼的网络工具 — 特权助手（setuid root 二进制）
//
//  作用：以 root 身份执行预定义的网络修复动作，让主程序免密调用。
//  安全：只接受固定 action 名 + 严格参数校验，拒绝任意命令。
//
//  安装位置：/usr/local/bin/netrepair-helper（chown root:wheel, chmod 4755）
//  编译：swiftc -O NetRepairHelper.swift -o netrepair-helper
//

import Foundation

// MARK: - 基础工具

private struct HelperResult: Encodable {
    let ok: Bool
    let message: String
    let output: String
    let action: String
}

private func output(_ ok: Bool, _ message: String, _ commandOutput: String = "", action: String) -> Never {
    let result = HelperResult(ok: ok, message: message, output: commandOutput, action: action)
    let data = try! JSONEncoder().encode(result)
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data("\n".utf8))
    exit(ok ? 0 : 1)
}

/// 执行一条 shell 命令（helper 已是 root，直接执行即可）
@discardableResult
private func shell(_ command: String, timeout: TimeInterval = 30) -> (status: Int32, output: String) {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/bin/zsh")
    process.arguments = ["-c", command]

    let pipe = Pipe()
    process.standardOutput = pipe
    process.standardError = pipe

    // 超时保护
    let semaphore = DispatchSemaphore(value: 0)
    process.terminationHandler = { _ in semaphore.signal() }

    do {
        try process.run()
    } catch {
        return (-1, "启动失败：\(error.localizedDescription)")
    }

    if semaphore.wait(timeout: .now() + timeout) == .timedOut {
        process.terminate()
        _ = semaphore.wait(timeout: .now() + 2)
        return (-9, "执行超时")
    }

    let data = pipe.fileHandleForReading.readDataToEndOfFile()
    let out = String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    return (process.terminationStatus, out)
}

// MARK: - 参数校验

private let ipPattern = #"^\d{1,3}(\.\d{1,3}){3}$"#
private let ifacePattern = #"^[a-z]+\d+$"#  // en0, en6, utun8...

private func validIP(_ s: String) -> Bool {
    guard s.range(of: ipPattern, options: .regularExpression) != nil else { return false }
    return s.split(separator: ".").allSatisfy { (Int($0) ?? 256) <= 255 }
}

private func validIface(_ s: String) -> Bool {
    s.range(of: ifacePattern, options: .regularExpression) != nil
}

/// 合法主机名/域名（含通配符前缀 *.）
private func validDomain(_ s: String) -> Bool {
    s.range(of: #"^(\*\.)?[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)+$"#, options: .regularExpression) != nil
}

/// 合法 bypass 条目：域名（可带 *.）或 IP（可带 /CIDR 或 :port），或 localhost 等保留字
/// 用于过滤误混入的命令输出垃圾（如 "cp: ... Permission denied"）
private func validBypassDomain(_ s: String) -> Bool {
    let t = s.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !t.isEmpty, t.count < 100, !t.contains(" ") else { return false }
    if t == "localhost" || t == "*.local" || t == "127.0.0.1" || t == "<local>" { return true }
    if validDomain(t) { return true }
    // IP 或 IP/CIDR 或 IP:port
    if t.range(of: #"^\d{1,3}(\.\d{1,3}){3}(/\d{1,2})?(:\d{1,5})?$"#, options: .regularExpression) != nil { return true }
    return false
}

/// 网卡名转网络服务名（Wi-Fi / 以太网 等）
private func serviceForDevice(_ device: String) -> String {
    let out = shell("/usr/sbin/networksetup -listnetworkserviceorder 2>/dev/null").output
    var pending = ""
    for line in out.split(separator: "\n") {
        let s = String(line)
        if let r = s.range(of: #"^\(\d+\)\s+"#, options: .regularExpression) {
            pending = String(s[r.upperBound...]).trimmingCharacters(in: .whitespaces).trimmingCharacters(in: CharacterSet(charactersIn: "\""))
        } else if s.contains("Device: \(device)") && !pending.isEmpty {
            return pending
        }
    }
    return device == "en0" ? "Wi-Fi" : device
}

// MARK: - 读操作辅助（helper 内部也需要读一些状态）

private func routeInfo(_ dest: String = "default") -> [String: String] {
    let out = shell("/sbin/route -n get \(dest) 2>/dev/null").output
    var d: [String: String] = [:]
    for line in out.split(separator: "\n") {
        let parts = line.split(separator: ":", maxSplits: 1).map(String.init)
        if parts.count == 2 {
            d[parts[0].trimmingCharacters(in: .whitespaces)] = parts[1].trimmingCharacters(in: .whitespaces)
        }
    }
    return d
}

private func activeService() -> String {
    let iface = routeInfo()["interface"] ?? ""
    return serviceForDevice(iface)
}

private func halfRoutes() -> [(dest: String, gw: String)] {
    let out = shell("/usr/sbin/netstat -rn -f inet 2>/dev/null").output
    return out.split(separator: "\n").compactMap { raw in
        let f = raw.split(whereSeparator: { $0 == " " || $0 == "\t" }).map(String.init)
        guard f.count >= 2, f[0] == "0/1" || f[0] == "128.0/1" else { return nil }
        return (f[0], f[1])
    }
}

private func vpnGateway(firstDNS: String) -> String {
    if let g = halfRoutes().first?.gw { return g }
    guard !firstDNS.isEmpty else { return "" }
    let r = routeInfo(firstDNS)
    let iface = r["interface"] ?? ""
    if iface.hasPrefix("utun") || iface.hasPrefix("tun") { return r["gateway"] ?? "" }
    return ""
}

// MARK: - 各 action 实现
// 注：helper 不再硬编码任何公司信息，所有内网参数通过命令行 --cidr/--dns/--resolver/--host/--probe-ip 传入

/// action: flush-dns
private func doFlushDNS() {
    let r = shell("/usr/bin/dscacheutil -flushcache; /usr/bin/killall -HUP mDNSResponder 2>/dev/null || true")
    output(r.status == 0, r.status == 0 ? "DNS 缓存已刷新" : "刷新失败", r.output, action: "flush-dns")
}

/// action: set-dns --service X --primary Y [--secondary Z | --primary empty]
private func doSetDNS(_ args: [String: String]) {
    guard let primary = args["primary"] else {
        output(false, "缺少 primary 参数", action: "set-dns")
    }
    let service = args["service"].flatMap { $0.isEmpty ? nil : $0 } ?? activeService()
    let secondary = args["secondary"] ?? ""

    var cmd: String
    if primary == "empty" {
        cmd = "/usr/sbin/networksetup -setdnsservers " + quote(service) + " empty"
    } else {
        guard validIP(primary) else { output(false, "primary IP 格式错误", action: "set-dns") }
        cmd = "/usr/sbin/networksetup -setdnsservers " + quote(service) + " " + quote(primary)
        if !secondary.isEmpty {
            guard validIP(secondary) else { output(false, "secondary IP 格式错误", action: "set-dns") }
            cmd += " " + quote(secondary)
        }
    }
    cmd += "; /usr/bin/dscacheutil -flushcache; /usr/bin/killall -HUP mDNSResponder 2>/dev/null || true"
    let r = shell(cmd)
    output(r.status == 0, primary == "empty" ? "\(service) 已恢复自动 DNS" : "\(service) DNS 已更新", r.output, action: "set-dns")
}

/// action: clear-proxy --service X
/// 注：代理备份由主程序在调用前写入（结构化 JSON），helper 不再覆盖它
private func doClearProxy(_ args: [String: String]) {
    let service = args["service"].flatMap { $0.isEmpty ? nil : $0 } ?? activeService()
    let cmd = [
        "/usr/sbin/networksetup -setwebproxystate \(quote(service)) off",
        "/usr/sbin/networksetup -setsecurewebproxystate \(quote(service)) off",
        "/usr/sbin/networksetup -setsocksfirewallproxystate \(quote(service)) off",
        "/usr/sbin/networksetup -setautoproxystate \(quote(service)) off"
    ].joined(separator: "; ")
    let r = shell(cmd)
    output(r.status == 0, "已临时关闭 \(service) 的系统代理", r.output, action: "clear-proxy")
}

/// action: restore-proxy — 完整恢复代理（主程序解析备份后传结构化参数）
/// 参数：--service X
///   --web/--secure/--socks "server:port:on|off"（空串跳过）
///   --auto "url:on|off"（空串跳过）
///   --bypass "domain1,domain2,..."（空串跳过）
private func doRestoreProxy(_ args: [String: String]) {
    guard let service = args["service"], !service.isEmpty else {
        output(false, "缺少 service 参数", action: "restore-proxy")
    }
    var commands: [String] = []
    func restoreProxyItem(_ spec: String, setFlag: String, stateFlag: String) -> Bool {
        // spec: "server:port:on|off"
        guard !spec.isEmpty else { return true }
        let parts = spec.split(separator: ":", omittingEmptySubsequences: false).map(String.init)
        guard parts.count == 3, validIP(parts[0]) || validDomain(parts[0]),
              let port = Int(parts[1]), port > 0 && port < 65536,
              parts[2] == "on" || parts[2] == "off" else { return false }
        if parts[2] == "on" {
            commands.append("/usr/sbin/networksetup \(setFlag) \(quote(service)) \(quote(parts[0])) \(quote(String(port)))")
        }
        commands.append("/usr/sbin/networksetup \(stateFlag) \(quote(service)) \(parts[2])")
        return true
    }
    guard restoreProxyItem(args["web"] ?? "", setFlag: "-setwebproxy", stateFlag: "-setwebproxystate"),
          restoreProxyItem(args["secure"] ?? "", setFlag: "-setsecurewebproxy", stateFlag: "-setsecurewebproxystate"),
          restoreProxyItem(args["socks"] ?? "", setFlag: "-setsocksfirewallproxy", stateFlag: "-setsocksfirewallproxystate") else {
        output(false, "代理参数格式错误", action: "restore-proxy")
    }
    // auto proxy: "url:on|off"
    if let auto = args["auto"], !auto.isEmpty {
        let parts = auto.split(separator: ":", omittingEmptySubsequences: false).map(String.init)
        // url 里可能带冒号（http://），只按最后一段拆 state
        if let last = parts.last, last == "on" || last == "off", parts.count >= 2 {
            let url = parts.dropLast().joined(separator: ":")
            if last == "on", !url.isEmpty {
                commands.append("/usr/sbin/networksetup -setautoproxyurl \(quote(service)) \(quote(url))")
            }
            commands.append("/usr/sbin/networksetup -setautoproxystate \(quote(service)) \(last)")
        }
    }
    // bypass 域名列表（仅接受合法域名，过滤垃圾）
    if let bypass = args["bypass"], !bypass.isEmpty {
        let domains = bypass.split(separator: ",").map(String.init).filter(validBypassDomain)
        if !domains.isEmpty {
            commands.append("/usr/sbin/networksetup -setproxybypassdomains \(quote(service)) " + domains.map(quote).joined(separator: " "))
        }
    }
    guard !commands.isEmpty else {
        output(false, "没有可恢复的代理配置", action: "restore-proxy")
    }
    commands.append("/usr/bin/dscacheutil -flushcache")
    let r = shell(commands.joined(separator: "; "))
    output(r.status == 0, "已恢复 \(service) 的代理配置", r.output, action: "restore-proxy")
}

/// action: renew-dhcp --iface X
private func doRenewDHCP(_ args: [String: String]) {
    guard let iface = args["iface"], validIface(iface), !iface.hasPrefix("utun") else {
        output(false, "无效的网卡名", action: "renew-dhcp")
    }
    let r = shell("/usr/sbin/ipconfig set \(quote(iface)) DHCP")
    let svc = serviceForDevice(iface)
    output(r.status == 0, r.status == 0 ? "已为 \(svc)（\(iface)）续租 DHCP" : "续租失败", r.output, action: "renew-dhcp")
}

/// action: vpn-coexist --cidr X --dns "a,b" --resolver Y --host Z --probe-ip W
private func doVpnCoexist(_ args: [String: String]) {
    let cidr = args["cidr"] ?? ""
    let dnsList = (args["dns"] ?? "").split(separator: ",").map(String.init).filter { !$0.isEmpty }
    let resolver = args["resolver"] ?? ""
    let host = args["host"] ?? ""
    let probeIP = args["probe-ip"] ?? ""

    // 前置：VPN 必须已连接（用探针 IP 判定）
    let route = probeIP.isEmpty ? ["interface": ""] : routeInfo(probeIP)
    let iface = route["interface"] ?? ""
    let connected = iface.hasPrefix("utun") || iface.hasPrefix("tun")
    guard connected || !halfRoutes().isEmpty else {
        output(false, "请先连接公司 VPN；当前没有检测到公司内网隧道", action: "vpn-coexist")
    }

    let gateway = vpnGateway(firstDNS: dnsList.first ?? "")
    guard !gateway.isEmpty else {
        output(false, "找不到 VPN 网关，未执行任何改动", action: "vpn-coexist")
    }

    let service = activeService()
    var commands: [String] = []

    // ① 精确路由：内网网段 + 公司 DNS 走 VPN
    if !cidr.isEmpty {
        commands.append("/sbin/route -n delete -net \(cidr) 2>/dev/null || true")
        commands.append("/sbin/route -n add -net \(cidr) \(quote(gateway))")
    }
    for dns in dnsList {
        commands.append("/sbin/route -n delete -host \(dns) 2>/dev/null || true")
        commands.append("/sbin/route -n add -host \(dns) \(quote(gateway))")
    }
    // ② 删除半世界劫持路由（让梯子恢复自由）
    for hr in halfRoutes() {
        let target = hr.dest == "0/1" ? "0.0.0.0/1" : "128.0.0.0/1"
        commands.append("/sbin/route -n delete -net \(target) \(quote(hr.gw)) 2>/dev/null || true")
    }
    // ③ 分域 DNS：resolver 域名只问公司 DNS（绕过 Tailscale 污染）
    if !resolver.isEmpty && !dnsList.isEmpty {
        let dnsLines = dnsList.map { "nameserver \($0)" }.joined(separator: "\\n")
        commands.append("/bin/mkdir -p /etc/resolver")
        commands.append("/usr/bin/printf '\(dnsLines)\\ntimeout 3\\n' > /etc/resolver/\(resolver)")
    }
    // ④ 代理直连名单加 *.<resolver> 和 host（梯子不抢内网流量）
    let bypassRaw = shell("/usr/sbin/networksetup -getproxybypassdomains \(quote(service))").output
    var bypass = bypassRaw.split(whereSeparator: { $0 == "," || $0 == "\n" }).map { $0.trimmingCharacters(in: .whitespaces) }.filter { validBypassDomain($0) }
    var domainsToAdd: [String] = []
    if !resolver.isEmpty { domainsToAdd.append("*.\(resolver)") }
    if !host.isEmpty { domainsToAdd.append(host) }
    for d in domainsToAdd where !bypass.contains(d) { bypass.append(d) }
    commands.append("/usr/sbin/networksetup -setproxybypassdomains \(quote(service)) " + bypass.map(quote).joined(separator: " "))
    // ⑤ 如果之前把公司 DNS 写成全局，改回自动（避免 VPN 断开后公共域名超时）
    let curDNS = shell("/usr/sbin/networksetup -getdnsservers \(quote(service))").output
    if dnsList.contains(where: { curDNS.contains($0) }) {
        commands.append("/usr/sbin/networksetup -setdnsservers \(quote(service)) empty")
    }
    commands.append("/usr/bin/dscacheutil -flushcache")
    commands.append("/usr/bin/killall -HUP mDNSResponder 2>/dev/null || true")

    let r = shell(commands.joined(separator: "; "), timeout: 20)
    Thread.sleep(forTimeInterval: 1.0)

    // 验证结果
    let after = probeIP.isEmpty ? ["interface": ""] : routeInfo(probeIP)
    let routeOK = (after["interface"] ?? "").hasPrefix("utun") || (after["interface"] ?? "").hasPrefix("tun")
    let hijacked = !halfRoutes().isEmpty
    let resolverOK = resolver.isEmpty || FileManager.default.fileExists(atPath: "/etc/resolver/\(resolver)")

    let allOK = routeOK && !hijacked && resolverOK
    let msg = allOK ? "VPN 与梯子共存已生效（分域 DNS + 删劫持路由 + 代理直连）"
                    : "共存配置已应用，但部分未生效，建议复查或重试"
    output(allOK, msg, "routeOK=\(routeOK) hijacked=\(hijacked) resolver=\(resolverOK) | " + r.output, action: "vpn-coexist")
}

/// action: vpn-coexist-reset --resolver Y [--dns "a,b"] [--bypass "d1,d2"]
/// dns/bypass 由主程序从 coexist-backup.json 解析后传入：有备份按备份恢复，无备份才回落 empty
private func doVpnCoexistReset(_ args: [String: String]) {
    let resolver = args["resolver"] ?? ""
    let service = activeService()
    var commands: [String] = []
    if !resolver.isEmpty { commands.append("/bin/rm -f /etc/resolver/\(resolver)") }

    // 恢复备份的 DNS：--dns 传的是备份值（空串 = 原本就是自动，恢复 empty）
    let dnsBackup = (args["dns"] ?? "").split(separator: ",").map(String.init).filter { validIP($0) }
    if !dnsBackup.isEmpty {
        commands.append("/usr/sbin/networksetup -setdnsservers \(quote(service)) " + dnsBackup.map(quote).joined(separator: " "))
    } else {
        commands.append("/usr/sbin/networksetup -setdnsservers \(quote(service)) empty")
    }
    // 恢复备份的 bypass 列表（过滤垃圾）
    let bypassBackup = (args["bypass"] ?? "").split(separator: ",").map(String.init).filter { validBypassDomain($0) }
    if !bypassBackup.isEmpty {
        commands.append("/usr/sbin/networksetup -setproxybypassdomains \(quote(service)) " + bypassBackup.map(quote).joined(separator: " "))
    }
    commands.append("/usr/bin/dscacheutil -flushcache; /usr/bin/killall -HUP mDNSResponder 2>/dev/null || true")
    let r = shell(commands.joined(separator: "; "))
    output(r.status == 0, "已撤销分域 DNS，并按备份恢复 DNS 与代理直连名单；重连 VPN 可恢复原始 VPN 路由", r.output, action: "vpn-coexist-reset")
}

/// action: install-helper（自举：把自己设为 setuid root）
/// 注：这个 action 需要 helper 已经被复制到 /usr/local/bin/ 但还没 setuid 时调用
/// 实际 setuid 设置由主程序的 installHelper() 通过 osascript 完成
private func doSelfTest() {
    let uid = getuid(), euid = geteuid()
    output(true, "self-test ok", "uid=\(uid) euid=\(euid) \(euid == 0 ? "(running as root ✓)" : "(NOT root)")", action: "self-test")
}

/// action: restart — 重启电脑（超级守护连续修复失败时用）
/// 走 /sbin/shutdown -r now，helper 是 root 免密执行
private func doRestart() {
    let r = shell("/sbin/shutdown -r now", timeout: 10)
    // shutdown 成功不会返回（系统重启了），到这里说明失败
    output(false, "重启失败：" + r.output, action: "restart")
}

// MARK: - shell 引用

private func quote(_ s: String) -> String {
    "'" + s.replacingOccurrences(of: "'", with: "'\\''") + "'"
}

// MARK: - 参数解析

/// 解析 --key value 形式的参数
private func parseArgs(_ argv: [String]) -> [String: String] {
    var result: [String: String] = [:]
    var i = 0
    while i < argv.count {
        let a = argv[i]
        if a.hasPrefix("--") {
            let key = String(a.dropFirst(2))
            if i + 1 < argv.count && !argv[i+1].hasPrefix("--") {
                result[key] = argv[i+1]
                i += 2
            } else {
                result[key] = ""
                i += 1
            }
        } else {
            i += 1
        }
    }
    return result
}

// MARK: - 主入口

let argv = Array(CommandLine.arguments.dropFirst())  // 去掉程序名
guard let action = argv.first else {
    output(false, "用法: netrepair-helper <action> [--key value...]", action: "none")
}

let actionArgs = parseArgs(Array(argv.dropFirst()))

switch action {
case "flush-dns":
    doFlushDNS()
case "set-dns":
    doSetDNS(actionArgs)
case "clear-proxy":
    doClearProxy(actionArgs)
case "restore-proxy":
    doRestoreProxy(actionArgs)
case "renew-dhcp":
    doRenewDHCP(actionArgs)
case "vpn-coexist":
    doVpnCoexist(actionArgs)
case "vpn-coexist-reset":
    doVpnCoexistReset(actionArgs)
case "self-test":
    doSelfTest()
case "restart":
    doRestart()
default:
    output(false, "未知 action：\(action)。白名单：flush-dns, set-dns, clear-proxy, restore-proxy, renew-dhcp, vpn-coexist, vpn-coexist-reset, self-test", action: action)
}
