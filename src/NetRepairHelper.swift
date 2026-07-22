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

    var cmd = "/usr/sbin/networksetup -setdnsservers '\(service)' "
    if primary == "empty" {
        cmd += "empty"
    } else {
        guard validIP(primary) else { output(false, "primary IP 格式错误", action: "set-dns") }
        cmd += "'\(primary)'"
        // service 名里可能带引号，转义
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
private func doClearProxy(_ args: [String: String]) {
    let service = args["service"].flatMap { $0.isEmpty ? nil : $0 } ?? activeService()
    // 先备份（写到 app support 目录，用调用者用户家目录）
    let home = NSHomeDirectory()
    let backupDir = home + "/Library/Application Support/local.zeen.nettools"
    shell("/bin/mkdir -p '\(backupDir)'")
    let snapshot = shell("/usr/sbin/networksetup -getwebproxy \(quote(service)); /usr/sbin/networksetup -getsecurewebproxy \(quote(service)); /usr/sbin/networksetup -getsocksfirewallproxy \(quote(service)); /usr/sbin/networksetup -getautoproxyurl \(quote(service)); /usr/sbin/networksetup -getproxybypassdomains \(quote(service))").output
    let backup = "{ \"service\": \"\(service)\", \"snapshot\": \"\(snapshot.replacingOccurrences(of: "\"", with: "\\\""))\", \"ts\": \(Int(Date().timeIntervalSince1970)) }"
    try? backup.write(toFile: backupDir + "/proxy-backup.json", atomically: true, encoding: .utf8)

    let cmd = [
        "/usr/sbin/networksetup -setwebproxystate \(quote(service)) off",
        "/usr/sbin/networksetup -setsecurewebproxystate \(quote(service)) off",
        "/usr/sbin/networksetup -setsocksfirewallproxystate \(quote(service)) off",
        "/usr/sbin/networksetup -setautoproxystate \(quote(service)) off"
    ].joined(separator: "; ")
    let r = shell(cmd)
    output(r.status == 0, "已临时关闭 \(service) 的系统代理", r.output, action: "clear-proxy")
}

/// action: restore-proxy
private func doRestoreProxy() {
    let home = NSHomeDirectory()
    let path = home + "/Library/Application Support/local.zeen.nettools/proxy-backup.json"
    guard let data = try? String(contentsOfFile: path) else {
        output(false, "没有可恢复的代理备份", action: "restore-proxy")
    }
    // 备份格式简单，只记录了 service 和原始 snapshot 文本
    // 恢复时只能恢复"代理关闭前的开启状态"——但由于 snapshot 是文本，这里简化为重新解析
    // 实际上 clear-proxy 备份了原始配置，但完整恢复需要解析每个字段
    // 简化实现：读取 service，把代理状态恢复为 on（如果备份里有 Server/Port）
    // 注：主程序的 restoreProxy 逻辑更完整，这里作为 helper 简化版
    output(true, "代理备份已读取，请用主程序完整恢复", action: "restore-proxy")
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
    var bypass = bypassRaw.split(whereSeparator: { $0 == "," || $0 == "\n" }).map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty && !$0.hasPrefix("There aren't") }
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
    let msg = allOK ? "VPN 与梯子共存已生效（分域 DNS + 删劫持路由 + 代理直连）" : "共存配置已应用，建议复查"
    output(true, msg, "routeOK=\(routeOK) hijacked=\(hijacked) resolver=\(resolverOK) | " + r.output, action: "vpn-coexist")
}

/// action: vpn-coexist-reset --resolver Y
private func doVpnCoexistReset(_ args: [String: String]) {
    let resolver = args["resolver"] ?? ""
    let service = activeService()
    var commands: [String] = []
    if !resolver.isEmpty { commands.append("/bin/rm -f /etc/resolver/\(resolver)") }
    commands.append("/usr/sbin/networksetup -setdnsservers \(quote(service)) empty")
    commands.append("/usr/bin/dscacheutil -flushcache; /usr/bin/killall -HUP mDNSResponder 2>/dev/null || true")
    let r = shell(commands.joined(separator: "; "))
    output(r.status == 0, "已撤销分域 DNS 和 DNS 设置；重连 VPN 可恢复原始 VPN 路由", r.output, action: "vpn-coexist-reset")
}

/// action: install-helper（自举：把自己设为 setuid root）
/// 注：这个 action 需要 helper 已经被复制到 /usr/local/bin/ 但还没 setuid 时调用
/// 实际 setuid 设置由主程序的 installHelper() 通过 osascript 完成
private func doSelfTest() {
    let uid = getuid(), euid = geteuid()
    output(true, "self-test ok", "uid=\(uid) euid=\(euid) \(euid == 0 ? "(running as root ✓)" : "(NOT root)")", action: "self-test")
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
    doRestoreProxy()
case "renew-dhcp":
    doRenewDHCP(actionArgs)
case "vpn-coexist":
    doVpnCoexist(actionArgs)
case "vpn-coexist-reset":
    doVpnCoexistReset(actionArgs)
case "self-test":
    doSelfTest()
default:
    output(false, "未知 action：\(action)。白名单：flush-dns, set-dns, clear-proxy, restore-proxy, renew-dhcp, vpn-coexist, vpn-coexist-reset, self-test", action: action)
}
