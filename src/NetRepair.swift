import Foundation
import CoreFoundation
import Darwin

func shellQuote(_ text: String) -> String { "'" + text.replacingOccurrences(of: "'", with: "'\\''") + "'" }
func appleQuote(_ text: String) -> String { "\"" + text.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\"", with: "\\\"") + "\"" }
let legacyHelper = "/usr/local/bin/netrepair-helper"
let legacyHelperHash = "9466607886a478331cd53669c799e7e02975840acedcc388c8657e5dd84df7a1"
func legacyRetirement(staged: Bool = false) throws -> String {
    var st = stat()
    guard lstat(legacyHelper, &st) == 0 else { guard errno == ENOENT else { throw fail("LEGACY_HELPER_UNVERIFIED", "无法检查旧版授权助手") }; return "" }
    guard st.st_uid == 0, st.st_mode & S_IFMT == S_IFREG, st.st_mode & 0o7777 == 0o4755,
          try sha256(legacyHelper) == legacyHelperHash else { throw fail("LEGACY_HELPER_UNVERIFIED", "旧授权文件不是已验证的原版助手；未修改它，请先通过旧版撤销授权") }
    let sourceProof = "if ! (" + legacyIdentityCheck(shellQuote(legacyHelper)) + "); then exit 1; fi"
    if staged {
        return sourceProof + "\n/bin/mv " + shellQuote(legacyHelper) + " \"$stage/legacy-helper\"\nif ! (" + legacyIdentityCheck("\"$stage/legacy-helper\"") + "); then exit 1; fi"
    }
    return sourceProof + "\n/bin/rm -f " + shellQuote(legacyHelper)
}
func legacyIdentityCheck(_ quotedPath: String) -> String {
    // %Op includes both file type and SUID. The caller supplies only fixed paths.
    return "test ! -L " + quotedPath + " && test \"$(/usr/bin/stat -f '%u:%Op' " + quotedPath + ")\" = '0:104755' && test \"$(/usr/bin/shasum -a 256 " + quotedPath + " | /usr/bin/cut -d ' ' -f 1)\" = " + shellQuote(legacyHelperHash)
}
func installationStageCleanup() -> String {
    // Never delete or restore an unknown object moved from the writable legacy parent.
    // Catchable signals attempt recovery; forced termination can leave this stage behind.
    return [
        "installation_cleanup() {",
        "result=$?", "trap - EXIT", "trap '' INT TERM HUP",
        "if [ -e \"$stage/legacy-helper\" ] || [ -L \"$stage/legacy-helper\" ]; then",
        "if ! (" + legacyIdentityCheck("\"$stage/legacy-helper\"") + "); then",
        "/usr/bin/printf '%s\\n' 'LEGACY_RESTORE_FAILED: unknown staged object retained' >&2", "exit 1", "fi",
        "if [ \"$result\" -ne 0 ]; then",
        "if test ! -e " + shellQuote(legacyHelper) + " && test ! -L " + shellQuote(legacyHelper) + " && /bin/link \"$stage/legacy-helper\" " + shellQuote(legacyHelper) + " && /bin/rm \"$stage/legacy-helper\"; then :; else",
        "/usr/bin/printf '%s\\n' 'LEGACY_RESTORE_FAILED: private installation stage retained' >&2", "exit 1", "fi", "fi", "fi",
        "/bin/rm -rf \"$stage\"", "exit \"$result\"", "}", "trap installation_cleanup EXIT",
        "trap 'exit 130' INT", "trap 'exit 143' TERM", "trap 'exit 129' HUP"
    ].joined(separator: "\n")
}
final class Engine {
    let configDir: String; let resourcesDir: String; let network = Network()
    init(configDir: String, resourcesDir: String) { self.configDir = configDir; self.resourcesDir = resourcesDir }
    func userDirectory() throws {
        guard configDir.hasPrefix("/"), !configDir.contains("\0") else { throw fail("INVALID_REQUEST", "配置路径无效") }
        if !fm.fileExists(atPath: configDir) { try fm.createDirectory(atPath: configDir, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700]) }
        try securePath(configDir, uid: getuid(), directory: true)
    }
    func configuration() throws -> [String: Any] {
        let current = configDir + "/config.json"
        if fm.fileExists(atPath: current) { try securePath(current, uid: getuid(), directory: false); return try configValue(decodeObject(Data(contentsOf: URL(fileURLWithPath: current)))) }
        let old = fm.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/local.zeen.nettools/config.json").path
        if fm.fileExists(atPath: old) {
            try securePath(old, uid: getuid(), directory: false)
            let legacy = try decodeObject(Data(contentsOf: URL(fileURLWithPath: old)))
            let config = try configValue(["company": legacy["company"] as? [String: Any] ?? [:], "vpn": legacy["vpn"] as? [String: Any] ?? [:]])
            try userDirectory(); try atomicJSON(config, path: current, uid: getuid()); return config
        }
        return try configValue([:])
    }
    func helperStatus() -> [String: Any] {
        do {
            try securePath(installedHelper, uid: 0, directory: false, mode: 0o4755)
            for parent in ["/Library", "/Library/PrivilegedHelperTools", "/Library/Application Support", privilegedState] { try securePath(parent, uid: 0, directory: true) }
            let r = try callHelper(Request(action: "helper-status", args: [:], background: true))
            return r
        } catch { return ["installed": false, "privileged": false, "version": nativeVersion, "message": "网络授权未安装或身份/版本不匹配", "errorCode": (error as? Failure)?.code ?? "PERMISSION_REQUIRED"] }
    }
    func callHelper(_ request: Request, config: [String: Any]? = nil) throws -> [String: Any] {
        try securePath(installedHelper, uid: 0, directory: false, mode: 0o4755)
        for parent in ["/Library", "/Library/PrivilegedHelperTools", "/Library/Application Support", privilegedState] { try securePath(parent, uid: 0, directory: true) }
        var args = request.args; if let config { args = ["config": config] }
        // The trusted helper forwards TERM to its own isolated groups. Never
        // kill that coordinator while it is still confirming descendant cleanup.
        let result = try nativeProcess(installedHelper, ["--rpc"], input: jsonData(["action": request.action, "args": args, "background": request.background]), timeout: 40, grace: .infinity)
        let data = Data(result.output.utf8)
        let object = try decodeObject(data)
        guard result.status == 0, object["ok"] as? Bool == true, let payload = object["data"] as? [String: Any] else {
            let e = object["error"] as? [String: String] ?? [:]; throw fail(e["code"] ?? "HELPER_FAILED", e["message"] ?? "授权助手未完成操作")
        }
        return payload
    }
    func admin(_ command: String) throws {
        let result = try network.command("/usr/bin/osascript", ["-e", "do shell script " + appleQuote(command) + " with administrator privileges"], timeout: 120, allowFailure: true)
        if result.status != 0, result.output.contains("LEGACY_RESTORE_FAILED") { throw fail("LEGACY_RECOVERY_REQUIRED", "旧授权助手恢复未完成；安装暂存已保留，授权状态未验证") }
        guard result.status == 0 else { throw fail(result.output.contains("(-128)") ? "AUTH_CANCELLED" : "AUTHORIZATION_FAILED", "系统授权未完成；授权状态未验证") }
    }
    func install() throws -> [String: Any] {
        let bundled = resourcesDir + "/netrepair-helper", manifestPath = resourcesDir + "/native-manifest.json"
        let manifest = try decodeObject(Data(contentsOf: URL(fileURLWithPath: manifestPath)))
        let engine = URL(fileURLWithPath: CommandLine.arguments[0]).standardizedFileURL.resolvingSymlinksInPath().path
        let helperHash = try sha256(bundled), engineHash = try sha256(engine)
        guard manifest["version"] as? String == nativeVersion, manifest["helperHash"] as? String == helperHash, manifest["engineHash"] as? String == engineHash else { throw fail("HASH_MISMATCH", "原生授权包哈希或版本不匹配") }
        for parent in ["/Library", "/Library/Application Support"] { try securePath(parent, uid: 0, directory: true) }
        for parent in ["/Library/PrivilegedHelperTools", privilegedState] where fm.fileExists(atPath: parent) { try securePath(parent, uid: 0, directory: true) }
        for path in [installedHelper, grantFile] where fm.fileExists(atPath: path) { try securePath(path, uid: 0, directory: false) }
        let grant = try jsonData(["version": nativeVersion, "installerUID": Int(getuid()), "engineHash": engineHash, "helperHash": helperHash]).base64EncodedString()
        // Only explicit install invokes this fixed script. All variable paths are
        // shell-quoted, and the root copy is checked again before atomic rename.
        let retirement = try legacyRetirement(staged: true)
        let script = [
            "set -eu", "umask 077",
            "test ! -L /Library/PrivilegedHelperTools", "test ! -L " + shellQuote(privilegedState),
            "/bin/mkdir -p /Library/PrivilegedHelperTools " + shellQuote(privilegedState),
            "test \"$(/usr/bin/stat -f '%u' /Library/PrivilegedHelperTools)\" = 0", "test \"$(/usr/bin/stat -f '%u' " + shellQuote(privilegedState) + ")\" = 0",
            "test ! -L " + shellQuote(installedHelper), "test ! -L " + shellQuote(grantFile),
            "/bin/chmod 755 /Library/PrivilegedHelperTools", "/bin/chmod 700 " + shellQuote(privilegedState),
            "stage=$(/usr/bin/mktemp -d /Library/PrivilegedHelperTools/.nettools-install.XXXXXX)", installationStageCleanup(),
            "/bin/cp " + shellQuote(bundled) + " \"$stage/helper\"",
            "test \"$(/usr/bin/shasum -a 256 \"$stage/helper\" | /usr/bin/cut -d ' ' -f 1)\" = " + shellQuote(helperHash),
            "test \"$(/usr/bin/shasum -a 256 " + shellQuote(engine) + " | /usr/bin/cut -d ' ' -f 1)\" = " + shellQuote(engineHash),
            "/usr/bin/printf %s " + shellQuote(grant) + " | /usr/bin/base64 -D > \"$stage/grant\"",
            "/usr/sbin/chown root:wheel \"$stage/helper\" \"$stage/grant\"", "/bin/chmod 4755 \"$stage/helper\"", "/bin/chmod 600 \"$stage/grant\"",
            retirement,
            "/bin/mv -f \"$stage/grant\" " + shellQuote(grantFile), "/bin/mv -f \"$stage/helper\" " + shellQuote(installedHelper)
        ].joined(separator: "\n")
        try admin(script)
        let status = helperStatus(); guard status["installed"] as? Bool == true else { throw fail("VERIFY_FAILED", "授权安装后身份校验失败") }
        return ["installed": true, "message": "已为当前用户授权固定网络动作；可随时撤销"]
    }
    func uninstall() throws -> [String: Any] {
        for parent in ["/Library", "/Library/PrivilegedHelperTools", "/Library/Application Support"] where fm.fileExists(atPath: parent) { try securePath(parent, uid: 0, directory: true) }
        for path in [installedHelper, grantFile] where fm.fileExists(atPath: path) { try securePath(path, uid: 0, directory: false) }
        // Snapshot state is intentionally retained for a later authorized restore.
        let retirement = try legacyRetirement()
        try admin("set -eu\ntest ! -L " + shellQuote(installedHelper) + "\ntest ! -L " + shellQuote(grantFile) + "\n/bin/rm -f " + shellQuote(installedHelper) + " " + shellQuote(grantFile) + "\n" + retirement)
        guard !fm.fileExists(atPath: installedHelper), !fm.fileExists(atPath: grantFile) else { throw fail("VERIFY_FAILED", "授权撤销未完成") }
        return ["installed": false, "message": "网络授权已撤销；原始恢复快照保留"]
    }
    func invoke(_ request: Request) throws -> [String: Any] {
        if privilegedActions.contains(request.action) { return try callHelper(request, config: request.action == "vpn-coexist" ? configuration() : nil) }
        switch request.action {
        case "get-config": return ["config": try configuration(), "version": nativeVersion]
        case "export-config": return ["json": String(data: try jsonData(configuration()), encoding: .utf8)!]
        case "save-config", "import-config":
            let raw = request.action == "save-config" ? request.args["config"] as! [String: Any] : try decodeObject(Data((request.args["json"] as! String).utf8)), config = try configValue(raw)
            try userDirectory(); try atomicJSON(config, path: configDir + "/config.json", uid: getuid()); return ["message": "配置已保存", "config": config]
        case "helper-status": return helperStatus()
        case "install-helper": guard !request.background else { throw fail("PERMISSION_REQUIRED", "后台不得请求安装授权") }; return try install()
        case "uninstall-helper": guard !request.background else { throw fail("PERMISSION_REQUIRED", "后台不得请求撤销授权") }; return try uninstall()
        case "get-status": return try network.status()
        case "network-check": return try network.check()
        case "diagnose":
            let check = try network.check()
            let proxies = check["proxies"] as? [String: Any] ?? [:]
            let enabled = ["web", "secure", "socks"].compactMap { key -> String? in
                guard let p = proxies[key] as? [String: Any], p["enabled"] as? Bool == true else { return nil }
                return "\(key): \(p["host"] ?? ""):\(p["port"] ?? 0) · \(p["reachable"] as? Bool == true ? "可达" : "不可达")"
            }
            let pac = (proxies["auto"] as? [String: Any])?["enabled"] as? Bool == true
            let proxyDetail = (enabled + (pac ? ["PAC 自动代理已启用"] : [])).joined(separator: "；")
            let firewall = try? network.command("/usr/libexec/ApplicationFirewall/socketfilterfw", ["--getglobalstate"], timeout: 3, allowFailure: true)
            var hostCount: Int?
            if let raw = try? Data(contentsOf: URL(fileURLWithPath: "/etc/hosts")), raw.count <= 262144, let text = String(data: raw, encoding: .utf8) {
                hostCount = text.split(separator: "\n").filter { line in let line = line.trimmingCharacters(in: .whitespaces); return !line.isEmpty && !line.hasPrefix("#") && !line.contains("localhost") && !line.contains("broadcasthost") }.count
            }
            let items: [[String: Any]] = [
                ["name": "本机网络", "detail": "\(check["service"] ?? "") · \(check["ip"] ?? "")", "status": (check["ip"] as? String ?? "").isEmpty ? "err" : "ok"],
                ["name": "默认路由", "detail": check["gateway"] ?? "", "status": (check["gateway"] as? String ?? "").isEmpty ? "err" : "ok"],
                ["name": "公网 IP 连通", "detail": check["rawOk"] as? Bool == true ? "IP 直连探测成功" : "探测未成功，结合 HTTPS 判断；单一探测不决定断网", "status": check["rawOk"] as? Bool == true ? "ok" : "warn"],
                ["name": "DNS 解析", "detail": check["dnsIp"] ?? "", "status": check["dnsOk"] as? Bool == true ? "ok" : "warn"],
                ["name": "HTTPS", "detail": "HTTP \(check["httpCode"] ?? 0)", "status": check["httpOk"] as? Bool == true ? "ok" : "err"],
                ["name": "系统代理", "detail": proxyDetail.isEmpty ? "未开启代理" : proxyDetail, "status": check["issue"] as? String == "stale-proxy" ? "err" : proxyDetail.isEmpty ? "info" : "ok"],
                ["name": "hosts 文件", "detail": hostCount.map { "自定义映射：\($0) 条" } ?? "无法读取", "status": hostCount == nil ? "info" : hostCount == 0 ? "ok" : "warn"],
                ["name": "防火墙", "detail": firewall?.status == 0 ? firewall!.output : "无法读取状态", "status": "info"]
            ]
            return ["items": items, "issue": check["issue"] ?? "unknown", "check": check]
        case "wifi-info":
            let id = try network.identity(), current = try network.command("/usr/sbin/networksetup", ["-getairportnetwork", id.interface], allowFailure: true)
            let details = try network.command("/usr/sbin/system_profiler", ["SPAirPortDataType", "-json", "-detailLevel", "mini"], timeout: 12, allowFailure: true)
            return ["interface": id.interface, "service": id.service, "ip": id.ip, "network": current.status == 0 ? current.output : "无法读取 SSID；可能需要定位权限", "details": details.status == 0 ? details.output : "", "ok": current.status == 0]
        case "ping-test":
            var items: [[String: Any]] = []
            for ip in ["223.5.5.5", "1.1.1.1", "8.8.8.8"] { let r = try network.command("/sbin/ping", ["-c", "2", "-W", "1000", ip], timeout: 4, allowFailure: true); items.append(["ip": ip, "name": ip, "ok": r.status == 0, "detail": r.output]) }; return ["items": items]
        case "speedtest":
            let result = try network.web.fetch(URL(string: "https://speed.cloudflare.com/__down?bytes=25000000")!, direct: false, timeout: 20, download: true)
            guard result["ok"] as? Bool == true, let bytes = result["bytes"] as? Int, let duration = result["duration"] as? Double, bytes > 0, duration > 0 else { return ["ok": false, "mbps": 0, "message": "测速源或实际系统代理路径不可达"] }
            return ["ok": true, "mbps": Double(bytes) * 8 / duration / 1000000, "source": "Cloudflare 25MB", "proxyPath": "system"]
        case "vpn-status": return try network.vpnStatus(configuration())
        case "vpn-connect":
            let config = try configuration(), vpn = config["vpn"] as! [String: Any], name = vpn["configName"] as! String
            guard vpn["enabled"] as? Bool == true, !name.isEmpty, fm.fileExists(atPath: "/Applications/Tunnelblick.app") else { throw fail("VPN_NOT_CONFIGURED", "请配置 VPN 并安装 Tunnelblick") }
            try network.command("/usr/bin/osascript", ["-e", "tell application \"Tunnelblick\" to connect " + appleQuote(name)], timeout: 15); return ["message": "已请求 Tunnelblick 连接，隧道仍需建立"]
        default: throw fail("INVALID_REQUEST", "不支持的操作")
        }
    }
}
@main struct EngineMain {
    static func main() {
        NativeRegistry.shared.installSignals()
        do {
            let object = try readInput(), request = try validate(object)
            if CommandLine.arguments == [CommandLine.arguments[0], "--validate-only"] { reply(["valid": true, "version": nativeVersion]); return }
            let argv = Array(CommandLine.arguments.dropFirst())
            guard argv.count == 5, argv[0] == "--rpc", argv[1] == "--config-dir", argv[3] == "--resources-dir", argv[2].hasPrefix("/"), argv[4].hasPrefix("/") else { throw fail("INVALID_REQUEST", "仅接受固定 JSON 接口与明确的应用目录") }
            reply(try Engine(configDir: argv[2], resourcesDir: argv[4]).invoke(request))
        } catch { reply(error: error, extra: ["cleanupComplete": NativeRegistry.shared.isEmpty()]) }
    }
}
