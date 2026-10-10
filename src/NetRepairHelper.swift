import Foundation
import CryptoKit
import CFNetwork
import Darwin

let nativeVersion = "5.0.0"
let installedHelper = "/Library/PrivilegedHelperTools/com.laoyu.nettools.helper"
let privilegedState = "/Library/Application Support/com.laoyu.nettools"
let grantFile = privilegedState + "/grant.json"
let fm = FileManager.default
struct Failure: Error { let code: String; let message: String }
func fail(_ code: String, _ message: String) -> Failure { Failure(code: code, message: message) }
func jsonData(_ object: Any) throws -> Data { try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]) }
func decodeObject(_ data: Data) throws -> [String: Any] {
    guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { throw fail("INVALID_REQUEST", "JSON 必须是对象") }; return object
}
func reply(_ data: [String: Any] = [:], error: Error? = nil, extra: [String: Any] = [:]) {
    var result: [String: Any] = ["ok": error == nil]
    if let error { let e = error as? Failure ?? fail("OPERATION_FAILED", error.localizedDescription); result["error"] = ["code": e.code, "message": e.message] } else { result["data"] = data }
    for (key, value) in extra { result[key] = value }
    if let bytes = try? jsonData(result) { FileHandle.standardOutput.write(bytes); FileHandle.standardOutput.write(Data([10])) }
}
func readInput() throws -> [String: Any] {
    let input = FileHandle.standardInput.readData(ofLength: 65537)
    guard input.count <= 65536 else { throw fail("INVALID_REQUEST", "请求超过大小限制") }; return try decodeObject(input)
}
func isIP(_ value: String) -> Bool {
    var v4 = in_addr(), v6 = in6_addr()
    return value.withCString { inet_pton(AF_INET, $0, &v4) == 1 || inet_pton(AF_INET6, $0, &v6) == 1 }
}
func matches(_ value: String, _ pattern: String) -> Bool { value.range(of: pattern, options: .regularExpression) != nil }
func isDomain(_ value: String) -> Bool { value.utf8.count <= 253 && matches(value, #"^([A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?$"#) }
func isCIDR(_ value: String) -> Bool {
    let parts = value.split(separator: "/", omittingEmptySubsequences: false).map(String.init)
    return parts.count == 2 && isIP(parts[0]) && !parts[0].contains(":") && matches(parts[1], #"^([0-9]|[12][0-9]|3[0-2])$"#)
}
func safeText(_ value: Any?, fallback: String = "", max: Int = 120) throws -> String {
    guard let text = value as? String ?? (value == nil ? fallback : nil), text.utf8.count <= max,
          !text.unicodeScalars.contains(where: { $0.value < 32 || $0.value == 127 }) else { throw fail("INVALID_REQUEST", "文本格式无效") }; return text
}
func onlyKeys(_ object: [String: Any], _ allowed: Set<String>) throws { guard Set(object.keys).isSubset(of: allowed) else { throw fail("INVALID_REQUEST", "不接受未知字段") } }
func boolValue(_ value: Any?, fallback: Bool = false) throws -> Bool {
    guard let value else { return fallback }
    guard let number = value as? NSNumber, CFGetTypeID(number) == CFBooleanGetTypeID() else { throw fail("INVALID_REQUEST", "开关必须是布尔值") }; return number.boolValue
}
func configValue(_ input: [String: Any]) throws -> [String: Any] {
    try onlyKeys(input, ["company", "vpn", "windows"])
    func section(_ key: String) throws -> [String: Any] { guard input[key] == nil || input[key] is [String: Any] else { throw fail("INVALID_REQUEST", "配置结构无效") }; return input[key] as? [String: Any] ?? [:] }
    let company = try section("company"), vpn = try section("vpn"), windows = try section("windows")
    try onlyKeys(company, ["name", "intranetCIDR", "intranetDNS", "resolverDomain", "internalHost", "internalProbeIP"])
    try onlyKeys(vpn, ["enabled", "configName", "clientAppPath"]); try onlyKeys(windows, ["adapterName"])
    let cidr = try safeText(company["intranetCIDR"]), resolver = try safeText(company["resolverDomain"], max: 253), host = try safeText(company["internalHost"], max: 253), probe = try safeText(company["internalProbeIP"])
    guard cidr.isEmpty || isCIDR(cidr), resolver.isEmpty || isDomain(resolver), host.isEmpty || isDomain(host), probe.isEmpty || isIP(probe) else { throw fail("INVALID_REQUEST", "IP、域名或网段格式无效") }
    guard company["intranetDNS"] == nil || company["intranetDNS"] is [String] else { throw fail("INVALID_REQUEST", "DNS 必须是 IP 列表") }
    let dns = company["intranetDNS"] as? [String] ?? []
    guard dns.count <= 4 && dns.allSatisfy(isIP) else { throw fail("INVALID_REQUEST", "DNS 地址无效") }
    let name = try safeText(vpn["configName"]); guard !name.hasPrefix("/") else { throw fail("INVALID_REQUEST", "VPN 名称不能是命令选项") }
    let client = try safeText(vpn["clientAppPath"], fallback: "/Applications/Tunnelblick.app", max: 253)
    guard client == "/Applications/Tunnelblick.app" else { throw fail("INVALID_REQUEST", "不接受任意 VPN 客户端路径") }
    return ["company": ["name": try safeText(company["name"], max: 80), "intranetCIDR": cidr, "intranetDNS": dns, "resolverDomain": resolver, "internalHost": host, "internalProbeIP": probe],
            "vpn": ["enabled": try boolValue(vpn["enabled"]), "configName": name, "clientAppPath": client], "windows": ["adapterName": try safeText(windows["adapterName"])]]
}
let readActions: Set<String> = ["get-status", "network-check", "diagnose", "wifi-info", "ping-test", "speedtest", "vpn-status", "helper-status", "get-config", "export-config"]
let privilegedActions: Set<String> = ["flush-dns", "set-dns", "restore-dns", "clear-proxy", "restore-proxy", "renew-dhcp", "vpn-coexist", "vpn-coexist-reset"]
let engineActions = readActions.union(privilegedActions).union(["vpn-connect", "save-config", "import-config", "install-helper", "uninstall-helper"])
struct Request { let action: String; let args: [String: Any]; let background: Bool }
func validate(_ object: [String: Any], helper: Bool = false) throws -> Request {
    var keys: Set<String> = ["action", "args", "background"]
    #if TESTING
    keys.insert("fixture")
    #endif
    try onlyKeys(object, keys)
    guard let action = object["action"] as? String, (helper ? privilegedActions.union(["helper-status"]) : engineActions).contains(action),
          let args = object["args"] as? [String: Any] ?? (object["args"] == nil ? [:] : nil) else { throw fail("INVALID_REQUEST", "不支持的操作或参数") }
    let background = try boolValue(object["background"])
    if action == "set-dns" {
        try onlyKeys(args, ["primary", "secondary"])
        let primary = try safeText(args["primary"]), secondary = try safeText(args["secondary"])
        guard primary == "empty" || isIP(primary), secondary.isEmpty || isIP(secondary), primary != "empty" || secondary.isEmpty else { throw fail("INVALID_REQUEST", "DNS 地址格式无效") }
    } else if action == "save-config" {
        try onlyKeys(args, ["config"]); guard let c = args["config"] as? [String: Any] else { throw fail("INVALID_REQUEST", "缺少配置") }; _ = try configValue(c)
    } else if action == "import-config" {
        try onlyKeys(args, ["json"]); guard let text = args["json"] as? String, text.utf8.count <= 32768 else { throw fail("INVALID_REQUEST", "配置文本无效") }; _ = try configValue(decodeObject(Data(text.utf8)))
    } else if helper && action == "vpn-coexist" {
        try onlyKeys(args, ["config"]); guard let c = args["config"] as? [String: Any] else { throw fail("INVALID_REQUEST", "缺少 VPN 配置") }; _ = try configValue(c)
    } else { try onlyKeys(args, []) }
    return Request(action: action, args: args, background: background)
}
func sha256(_ path: String) throws -> String { SHA256.hash(data: try Data(contentsOf: URL(fileURLWithPath: path))).map { String(format: "%02x", $0) }.joined() }
func securePath(_ path: String, uid: uid_t, directory: Bool, mode: mode_t? = nil) throws {
    var st = stat(); guard lstat(path, &st) == 0, st.st_uid == uid, (st.st_mode & S_IFMT) == (directory ? S_IFDIR : S_IFREG), st.st_mode & 0o022 == 0 else { throw fail("PERMISSION_REQUIRED", "授权文件或目录权限无效") }
    if let mode, st.st_mode & 0o7777 != mode { throw fail("PERMISSION_REQUIRED", "授权文件权限不匹配") }
}
func atomicJSON(_ object: [String: Any], path: String, uid: uid_t) throws {
    let dir = URL(fileURLWithPath: path).deletingLastPathComponent().path
    if !fm.fileExists(atPath: dir) { try fm.createDirectory(atPath: dir, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700]) }
    try securePath(dir, uid: uid, directory: true)
    if fm.fileExists(atPath: path) { try securePath(path, uid: uid, directory: false) }
    let temp = dir + "/.snapshot-" + UUID().uuidString
    let fd = open(temp, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600); guard fd >= 0 else { throw fail("BACKUP_FAILED", "无法创建私有备份") }
    defer { close(fd); unlink(temp) }
    let data = try jsonData(object)
    var offset = 0
    try data.withUnsafeBytes { bytes in
        while offset < data.count { let n = Darwin.write(fd, bytes.baseAddress!.advanced(by: offset), data.count - offset); guard n > 0 else { throw fail("BACKUP_FAILED", "备份写入失败") }; offset += n }
    }
    guard fsync(fd) == 0, rename(temp, path) == 0 else { throw fail("BACKUP_FAILED", "备份保存失败") }
    let dfd = open(dir, O_RDONLY); if dfd >= 0 { _ = fsync(dfd); close(dfd) }
}
struct Command { let status: Int32; let output: String }
protocol Running { func run(_ path: String, _ args: [String], timeout: TimeInterval) throws -> Command }
// Each native child owns a new POSIX process group. No negative-PID signal is
// ever sent until spawn attributes and getpgid prove that isolated group.
final class NativeRegistry {
    static let shared = NativeRegistry(); private let lock = NSLock()
    private var children: [pid_t: () -> Void] = [:]; private var sources: [DispatchSourceSignal] = []
    private(set) var cancelled = false
    func start(cancel: @escaping () -> Void, launch: () throws -> pid_t) throws -> pid_t {
        lock.lock(); defer { lock.unlock() }
        guard !cancelled else { throw fail("ABORTED", "操作已取消") }
        let pid = try launch(); children[pid] = cancel; return pid
    }
    func remove(_ pid: pid_t) { lock.lock(); children.removeValue(forKey: pid); lock.unlock() }
    func isEmpty() -> Bool { lock.lock(); defer { lock.unlock() }; return children.isEmpty }
    func installSignals() {
        for number in [SIGTERM, SIGINT] {
            signal(number, SIG_IGN)
            let source = DispatchSource.makeSignalSource(signal: number, queue: .global(qos: .userInitiated))
            source.setEventHandler { self.lock.lock(); self.cancelled = true; let calls = Array(self.children.values); self.lock.unlock(); calls.forEach { $0() }
                // Remain alive until every isolated group has confirmed cleanup.
                while true { if self.isEmpty() { reply(error: fail("ABORTED", "操作已取消"), extra: ["cleanupComplete": true]); exit(130) }; Thread.sleep(forTimeInterval: 0.01) }
            }; sources.append(source); source.resume()
        }
    }
}
final class NativeCancellation {
    private let lock = NSLock(); private var value = false
    func cancel() { lock.lock(); value = true; lock.unlock() }
    func isCancelled() -> Bool { lock.lock(); defer { lock.unlock() }; return value }
}
final class SystemRunner: Running {
    func run(_ path: String, _ args: [String], timeout: TimeInterval = 5) throws -> Command { try nativeProcess(path, args, timeout: timeout) }
}
func nativeProcess(_ path: String, _ args: [String], input: Data? = nil, timeout: TimeInterval, grace: TimeInterval = 0.15) throws -> Command {
    signal(SIGPIPE, SIG_IGN)
    var outFD = [Int32](repeating: 0, count: 2), inFD = [Int32](repeating: 0, count: 2)
    guard pipe(&outFD) == 0 else { throw fail("PROCESS_START", "无法创建输出通道") }
    defer { close(outFD[0]) }
    let inputFD: Int32
    if input != nil { guard pipe(&inFD) == 0 else { close(outFD[1]); throw fail("PROCESS_START", "无法创建输入通道") }; inputFD = inFD[0] }
    else { inputFD = open("/dev/null", O_RDONLY) }
    guard inputFD >= 0 else { close(outFD[1]); throw fail("PROCESS_START", "无法打开输入通道") }
    var actions: posix_spawn_file_actions_t?, attr: posix_spawnattr_t?
    posix_spawn_file_actions_init(&actions); posix_spawnattr_init(&attr)
    defer { posix_spawn_file_actions_destroy(&actions); posix_spawnattr_destroy(&attr) }
    posix_spawn_file_actions_adddup2(&actions, inputFD, STDIN_FILENO)
    posix_spawn_file_actions_adddup2(&actions, outFD[1], STDOUT_FILENO)
    posix_spawn_file_actions_adddup2(&actions, outFD[1], STDERR_FILENO)
    posix_spawnattr_setflags(&attr, Int16(POSIX_SPAWN_SETPGROUP | POSIX_SPAWN_CLOEXEC_DEFAULT | POSIX_SPAWN_SETSIGDEF))
    posix_spawnattr_setpgroup(&attr, 0)
    var defaults = sigset_t(); sigemptyset(&defaults); sigaddset(&defaults, SIGTERM); sigaddset(&defaults, SIGINT); sigaddset(&defaults, SIGPIPE); posix_spawnattr_setsigdefault(&attr, &defaults)
    let argv: [UnsafeMutablePointer<CChar>?] = ([path] + args).map { text in text.withCString { strdup($0) } } + [nil]
    let environment: [String] = ["PATH=/usr/bin:/bin:/usr/sbin:/sbin", "LANG=en_US.UTF-8", "LC_ALL=C", "HOME=/var/empty"]
    let env: [UnsafeMutablePointer<CChar>?] = environment.map { text in text.withCString { strdup($0) } } + [nil]
    defer { argv.forEach { free($0) }; env.forEach { free($0) } }
    let cancellation = NativeCancellation()
    let pid: pid_t
    do {
        pid = try NativeRegistry.shared.start(cancel: { cancellation.cancel() }) {
            var spawned: pid_t = 0
            let started = argv.withUnsafeBufferPointer { a in env.withUnsafeBufferPointer { e in posix_spawn(&spawned, path, &actions, &attr, UnsafeMutablePointer(mutating: a.baseAddress!), UnsafeMutablePointer(mutating: e.baseAddress!)) } }
            guard started == 0 else { throw fail("PROCESS_START", "系统命令启动失败") }
            // A fast-exiting root process may already be gone; its group is still pid.
            let groupID = getpgid(spawned)
            guard groupID == spawned || (groupID < 0 && errno == ESRCH) else { kill(spawned, SIGKILL); var status: Int32 = 0; _ = waitpid(spawned, &status, 0); throw fail("PROCESS_START", "无法确认隔离进程组") }
            return spawned
        }
    } catch { close(inputFD); close(outFD[1]); if input != nil { close(inFD[1]) }; throw error }
    close(inputFD); close(outFD[1])
    _ = fcntl(outFD[0], F_SETFL, fcntl(outFD[0], F_GETFL) | O_NONBLOCK)
    if input != nil { _ = fcntl(inFD[1], F_SETFL, fcntl(inFD[1], F_GETFL) | O_NONBLOCK) }
    var inputOpen = input != nil, sent = 0
    defer { if inputOpen { close(inFD[1]) } }
    defer { NativeRegistry.shared.remove(pid) }
    let began = ProcessInfo.processInfo.systemUptime
    var data = Data(), status: Int32 = 0, reaped = false, eof = false, failure: Failure?, terminateAt: TimeInterval?, killed = false
    var bytes = [UInt8](repeating: 0, count: 8192)
    while true {
        for _ in 0..<32 {
            let n = Darwin.read(outFD[0], &bytes, bytes.count)
            if n > 0 { if data.count + n <= 524288 { data.append(contentsOf: bytes.prefix(n)) } else if failure == nil { failure = fail("OUTPUT_LIMIT", "系统输出超过大小限制") } }
            else { if n == 0 { eof = true }; break }
        }
        if inputOpen, let input {
            if sent < input.count { let n = input.withUnsafeBytes { Darwin.write(inFD[1], $0.baseAddress!.advanced(by: sent), min(4096, input.count - sent)) }; if n > 0 { sent += n } else if errno != EAGAIN && errno != EINTR { close(inFD[1]); inputOpen = false } }
            if inputOpen && sent == input.count { close(inFD[1]); inputOpen = false }
        }
        if !reaped { let waited = waitpid(pid, &status, WNOHANG); if waited == pid || (waited < 0 && errno == ECHILD) { reaped = true } }
        let now = ProcessInfo.processInfo.systemUptime
        if failure == nil && cancellation.isCancelled() { failure = fail("ABORTED", "操作已取消") }
        if failure == nil && now - began >= timeout { failure = fail("PROCESS_TIMEOUT", "系统命令超时") }
        let exists = kill(-pid, 0) == 0 || errno == EPERM
        // Children may outlive a normally-exiting launcher. They are still owned
        // by this command; clean them before resolving even a success result.
        if (failure != nil || reaped) && exists && terminateAt == nil { kill(-pid, SIGTERM); terminateAt = now }
        if let terminateAt, exists, now - terminateAt >= grace { kill(-pid, SIGKILL); killed = true }
        if reaped && !exists { if !eof { Thread.sleep(forTimeInterval: 0.005); continue }; break }
        // Cleanup is a barrier, not a two-second success/failure guess. If the OS
        // has not reaped the group, keep waiting and keep issuing KILL; callers
        // cannot start another command while descendants are unconfirmed.
        if killed && exists { kill(-pid, SIGKILL) }
        Thread.sleep(forTimeInterval: 0.005)
    }
    if let failure { throw failure }
    let exitStatus: Int32 = (status & 0x7f) == 0 ? (status >> 8) & 0xff : 128 + (status & 0x7f)
    return Command(status: exitStatus, output: (String(data: data, encoding: .utf8) ?? "").trimmingCharacters(in: .whitespacesAndNewlines))
}
#if TESTING
final class FixtureRunner: Running {
    var commands: [[String: Any]] = []; let fixture: [String: Any]; var dns: [String]; var proxies: [String: [String: String]] = [:]; var bypass: [String] = []; var routes: [[String: String]] = []
    init(_ fixture: [String: Any]) { self.fixture = fixture; dns = fixture["dns"] as? [String] ?? []; for key in ["web", "secure", "socks"] { proxies[key] = ["Enabled": "No", "Server": "", "Port": "0"] }; if let items = fixture["proxies"] as? [String: [String: String]] { proxies.merge(items) { _, new in new } }; if fixture["vpn"] as? Bool == true { routes = [["destination": "0.0.0.0/1", "gateway": "10.8.0.1", "interface": "utun8"], ["destination": "128.0.0.0/1", "gateway": "10.8.0.1", "interface": "utun8"]] } }
    func run(_ path: String, _ args: [String], timeout: TimeInterval = 5) throws -> Command {
        commands.append(["path": path, "args": args]); let flag = args.first ?? ""
        if (fixture["failFlags"] as? [String] ?? []).contains(flag) { return Command(status: 1, output: "fixture command failure") }
        switch flag {
        case "-listnetworkserviceorder": return Command(status: 0, output: "(1) Wi-Fi\n(Hardware Port: Wi-Fi, Device: en0)")
        case "-getinfo": return Command(status: 0, output: "\(fixture["method"] as? String ?? "DHCP") Configuration\nIP address: 192.0.2.2\nRouter: 192.0.2.1")
        case "-getdnsservers": return Command(status: 0, output: dns.isEmpty ? "There aren't any DNS Servers set on Wi-Fi." : dns.joined(separator: "\n"))
        case "-setdnsservers": dns = args.dropFirst(2).filter { $0 != "empty" }; return Command(status: 0, output: "")
        case "-getwebproxy", "-getsecurewebproxy", "-getsocksfirewallproxy": let key = flag.contains("secure") ? "secure" : flag.contains("socks") ? "socks" : "web"; return Command(status: 0, output: proxies[key]!.map { "\($0.key): \($0.value)" }.joined(separator: "\n"))
        case "-setwebproxystate", "-setsecurewebproxystate", "-setsocksfirewallproxystate": let key = flag.contains("secure") ? "secure" : flag.contains("socks") ? "socks" : "web"; proxies[key]!["Enabled"] = args.last == "on" ? "Yes" : "No"; return Command(status: 0, output: "")
        case "-setwebproxy", "-setsecurewebproxy", "-setsocksfirewallproxy": let key = flag.contains("secure") ? "secure" : flag.contains("socks") ? "socks" : "web"; proxies[key]!["Server"] = args[2]; proxies[key]!["Port"] = args[3]; return Command(status: 0, output: "")
        case "-getautoproxyurl": return Command(status: 0, output: "Enabled: No\nURL: ")
        case "-getproxybypassdomains": return Command(status: 0, output: bypass.isEmpty ? "There aren't any bypass domains set on Wi-Fi." : bypass.joined(separator: "\n"))
        case "-setproxybypassdomains": bypass = args.dropFirst(2).filter { $0 != "Empty" }; return Command(status: 0, output: "")
        case "-rn": return Command(status: 0, output: routes.map { "\($0["destination"]!) \($0["gateway"]!) UGSc \($0["interface"]!)" }.joined(separator: "\n"))
        case "-n":
            if args.count > 4, args[1] == "add" { routes.removeAll { $0["destination"] == args[3] }; routes.append(["destination": args[3], "gateway": args[4], "interface": "utun8"]); return Command(status: 0, output: "") }
            if args.count > 3, args[1] == "delete" { routes.removeAll { $0["destination"] == args[3] }; return Command(status: 0, output: "") }
            let vpn = fixture["vpn"] as? Bool == true && args.last != "default"
            return Command(status: 0, output: vpn ? "interface: utun8\ngateway: 10.8.0.1" : "interface: en0\ngateway: 192.0.2.1")
        case "getifaddr": return Command(status: 0, output: "192.0.2.2")
        case "-z": return Command(status: fixture["liveProxy"] as? Bool == true ? 0 : 1, output: "")
        case "+short": return Command(status: fixture["dnsResolves"] as? Bool == false ? 1 : 0, output: fixture["dnsResolves"] as? Bool == false ? "" : "203.0.113.7")
        default: return Command(status: 0, output: "")
        }
    }
}
#endif

struct Identity { let interface: String; let service: String; let ip: String; let gateway: String; let method: String }
final class Values {
    private let lock = NSLock(); private var values: [String: Any] = [:]
    func set(_ key: String, _ value: Any) { lock.lock(); defer { lock.unlock() }; values[key] = value }
    func all() -> [String: Any] { lock.lock(); defer { lock.unlock() }; return values }
}
protocol WebFetching {
    func fetch(_ url: URL, direct: Bool, timeout: TimeInterval, download: Bool) throws -> [String: Any]
}
// CFNetwork evaluates the actual system proxy dictionary, including PAC/WPAD,
// bypass rules and SOCKS. No curl proxy-selection approximation is used here.
final class SystemWebClient: WebFetching {
    private let settingsProvider: () -> [AnyHashable: Any]?
    init(settingsProvider: @escaping () -> [AnyHashable: Any]? = { CFNetworkCopySystemProxySettings()?.takeRetainedValue() as? [AnyHashable: Any] }) { self.settingsProvider = settingsProvider }
    func fetch(_ url: URL, direct: Bool = false, timeout: TimeInterval = 7, download: Bool = false) throws -> [String: Any] {
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = timeout; config.timeoutIntervalForResource = timeout
        config.urlCache = nil; config.requestCachePolicy = .reloadIgnoringLocalCacheData
        if direct { config.connectionProxyDictionary = ["HTTPEnable": 0, "HTTPSEnable": 0, "SOCKSEnable": 0, "ProxyAutoConfigEnable": 0, "ProxyAutoDiscoveryEnable": 0] }
        else { config.connectionProxyDictionary = settingsProvider() }
        let delegate = WebResponse(limit: download ? 32 * 1024 * 1024 : 4 * 1024 * 1024)
        let session = URLSession(configuration: config, delegate: delegate, delegateQueue: nil)
        defer { session.invalidateAndCancel() }
        let task = session.dataTask(with: url), start = ProcessInfo.processInfo.systemUptime
        task.resume()
        if delegate.ended.wait(timeout: .now() + timeout + 0.5) == .timedOut {
            task.cancel(); session.invalidateAndCancel(); _ = delegate.ended.wait(timeout: .now() + 2)
            throw fail("HTTP_TIMEOUT", "系统代理路径请求超时")
        }
        let result = delegate.result()
        return ["ok": result.error == nil && (200...399).contains(result.code), "code": result.code, "bytes": result.bytes, "duration": ProcessInfo.processInfo.systemUptime - start, "path": direct ? "direct" : "system"]
    }
}
final class WebResponse: NSObject, URLSessionDataDelegate, @unchecked Sendable {
    let ended = DispatchSemaphore(value: 0); let limit: Int; private let lock = NSLock()
    private var code = 0, bytes = 0, redirects = 0; private var error: Error?
    init(limit: Int) { self.limit = limit }
    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse, completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        lock.lock(); code = (response as? HTTPURLResponse)?.statusCode ?? 0; lock.unlock(); completionHandler(.allow)
    }
    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) { lock.lock(); bytes += data.count; let tooLarge = bytes > limit; lock.unlock(); if tooLarge { dataTask.cancel() } }
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { lock.lock(); redirects += 1; let allowed = redirects <= 3; lock.unlock(); completionHandler(allowed ? request : nil); if !allowed { task.cancel() } }
    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) { lock.lock(); self.error = error; lock.unlock(); ended.signal() }
    func result() -> (code: Int, bytes: Int, error: Error?) { lock.lock(); defer { lock.unlock() }; return (code, bytes, error) }
}
final class Network {
    let runner: Running; let web: WebFetching
    init(_ runner: Running = SystemRunner(), web: WebFetching = SystemWebClient()) { self.runner = runner; self.web = web }
    @discardableResult func command(_ path: String, _ args: [String], timeout: TimeInterval = 5, allowFailure: Bool = false) throws -> Command {
        let result = try runner.run(path, args, timeout: timeout)
        guard allowFailure || result.status == 0 else { throw fail("COMMAND_FAILED", "系统操作失败：\(URL(fileURLWithPath: path).lastPathComponent) \(args.first ?? "")") }; return result
    }
    func setup(_ flag: String, _ service: String, _ args: [String] = []) throws -> String { try command("/usr/sbin/networksetup", [flag, service] + args, timeout: flag.hasPrefix("-get") ? 2 : 5).output }
    func pairs(_ text: String) -> [String: String] {
        var result: [String: String] = [:]
        for line in text.split(separator: "\n") { let parts = line.split(separator: ":", maxSplits: 1, omittingEmptySubsequences: false); if parts.count == 2 { result[String(parts[0]).trimmingCharacters(in: .whitespaces)] = String(parts[1]).trimmingCharacters(in: .whitespaces) } }; return result
    }
    func services() throws -> [(service: String, interface: String)] {
        let raw = try command("/usr/sbin/networksetup", ["-listnetworkserviceorder"], timeout: 2).output
        var pending = "", result: [(String, String)] = []
        for line in raw.split(separator: "\n").map(String.init) {
            if let range = line.range(of: #"^\([0-9]+\)\s+"#, options: .regularExpression) { pending = String(line[range.upperBound...]).trimmingCharacters(in: .whitespaces) }
            else if !pending.isEmpty, let range = line.range(of: #"Device: ([A-Za-z]+[0-9]+)"#, options: .regularExpression) { let token = String(line[range]).replacingOccurrences(of: "Device: ", with: ""); result.append((pending, token)); pending = "" }
        }
        return result
    }
    func route(_ destination: String = "default") throws -> [String: String] { let r = try command("/sbin/route", ["-n", "get", destination], timeout: 2, allowFailure: true); return r.status == 0 ? pairs(r.output) : [:] }
    func identity() throws -> Identity {
        let all = try services(), route = try route()
        let interface = route["interface"] ?? ""
        var candidates = all.filter { $0.interface == interface } + all.filter { $0.interface != interface && matches($0.interface, #"^en[0-9]+$"#) }
        candidates = candidates.filter { matches($0.interface, #"^en[0-9]+$"#) }
        guard !candidates.isEmpty else { throw fail("NO_INTERFACE", "找不到物理网络服务") }
        var fallback: Identity?
        for candidate in candidates {
            let info = try setup("-getinfo", candidate.service), data = pairs(info)
            let method = info.hasPrefix("DHCP Configuration") ? "DHCP" : info.hasPrefix("Manual Configuration") ? "Manual" : "Unknown"
            let ip = data["IP address"].flatMap { isIP($0) ? $0 : nil } ?? data["IPv6 IP address"].flatMap { isIP($0) ? $0 : nil } ?? ""
            let current = Identity(interface: candidate.interface, service: candidate.service, ip: ip, gateway: route["gateway"] ?? data["Router"] ?? "", method: method)
            if !ip.isEmpty { return current }; if fallback == nil { fallback = current }
        }
        return fallback!
    }
    func verifyService(_ service: String) throws { guard try services().contains(where: { $0.service == service }) else { throw fail("SERVICE_CHANGED", "备份的网络服务已不存在") } }
    func dns(_ service: String) throws -> [String] {
        let text = try setup("-getdnsservers", service)
        if text.hasPrefix("There aren't any DNS Servers set on ") { return [] }
        let values = text.split(separator: "\n").map { $0.trimmingCharacters(in: .whitespaces) }
        guard !values.isEmpty && values.allSatisfy(isIP) else { throw fail("READ_FAILED", "DNS 配置读取失败") }; return values
    }
    func bypass(_ service: String) throws -> [String] {
        let text = try setup("-getproxybypassdomains", service)
        if text.hasPrefix("There aren't any bypass domains set on ") { return [] }
        let items = text.split(separator: "\n").map(String.init)
        guard items.allSatisfy({ !$0.isEmpty && $0.utf8.count <= 253 && !$0.contains(" ") && !$0.contains("\t") && !$0.hasPrefix("-") }) else { throw fail("READ_FAILED", "代理直连名单读取失败") }; return items
    }
    func proxy(_ service: String) throws -> [String: Any] {
        var result: [String: Any] = [:]
        for (key, flag) in [("web", "-getwebproxy"), ("secure", "-getsecurewebproxy"), ("socks", "-getsocksfirewallproxy")] {
            let raw = pairs(try setup(flag, service)); guard let enabled = raw["Enabled"], enabled == "Yes" || enabled == "No" else { throw fail("READ_FAILED", "代理配置读取失败") }
            let host = raw["Server"] ?? "", port = Int(raw["Port"] ?? "0") ?? 0
            guard enabled == "No" || ((!host.isEmpty && (isIP(host) || isDomain(host) || host == "localhost")) && (1...65535).contains(port)) else { throw fail("READ_FAILED", "代理端点无效") }
            let reachable = enabled == "Yes" ? (try command("/usr/bin/nc", ["-z", "-G", "1", host, String(port)], timeout: 2, allowFailure: true).status == 0) : false
            result[key] = ["enabled": enabled == "Yes", "host": host, "port": port, "reachable": reachable, "authenticated": raw["Authenticated Proxy Enabled"] == "1", "local": ["127.0.0.1", "::1", "localhost"].contains(host)]
        }
        let auto = pairs(try setup("-getautoproxyurl", service)); guard let enabled = auto["Enabled"], enabled == "Yes" || enabled == "No" else { throw fail("READ_FAILED", "PAC 配置读取失败") }
        result["auto"] = ["enabled": enabled == "Yes", "url": auto["URL"] ?? ""]; result["bypass"] = try bypass(service); return result
    }
    func resolve(_ host: String) throws -> [String] { pairs(try command("/usr/bin/dscacheutil", ["-q", "host", "-a", "name", host], timeout: 7).output).filter { $0.key == "ip_address" || $0.key == "ipv6_address" }.map(\.value).filter(isIP) }
    func http(_ url: String, direct: Bool = false) throws -> [String: Any] { try web.fetch(URL(string: url)!, direct: direct, timeout: 7, download: false) }
    func check() throws -> [String: Any] {
        let id = try identity(), proxy = try proxy(id.service), values = Values(), group = DispatchGroup()
        for (key, operation) in [
            ("dns", { () -> Any in (try? self.resolve("www.baidu.com")) ?? [] }),
            ("http", { () -> Any in (try? self.http("https://www.baidu.com")) ?? ["ok": false, "code": 0] }),
            ("direct", { () -> Any in (try? self.http("https://www.baidu.com", direct: true)) ?? ["ok": false, "code": 0] }),
            ("raw", { () -> Any in (try? self.http("http://110.242.68.66", direct: true)) ?? ["ok": false, "code": 0] })
        ] { group.enter(); DispatchQueue.global().async { values.set(key, operation()); group.leave() } }
        guard group.wait(timeout: .now() + 10) == .success else { throw fail("PROCESS_TIMEOUT", "网络检查超时") }
        let results = values.all(), dns = results["dns"] as? [String] ?? []
        let http = results["http"] as? [String: Any] ?? [:], direct = results["direct"] as? [String: Any] ?? [:], raw = results["raw"] as? [String: Any] ?? [:]
        let stale = ["web", "secure", "socks"].contains { key in guard let p = proxy[key] as? [String: Any] else { return false }; return p["enabled"] as? Bool == true && p["local"] as? Bool == true && p["reachable"] as? Bool == false }
        // Direct connectivity is useful evidence, but cannot certify configured
        // system proxy/PAC connectivity or hide an enabled dead loopback proxy.
        let webOK = http["ok"] as? Bool == true && !stale
        let issue = stale ? "stale-proxy" : webOK ? "ok" : id.ip.isEmpty ? "no-link" : id.gateway.isEmpty ? "no-route" : dns.isEmpty ? "dns" : "http"
        return ["ok": webOK, "issue": issue, "interface": id.interface, "service": id.service, "ip": id.ip, "gateway": id.gateway, "addressMethod": id.method, "dnsOk": !dns.isEmpty, "dnsIp": dns.first ?? "", "httpOk": webOK, "httpCode": http["code"] ?? 0, "directHttpOk": direct["ok"] ?? false, "rawOk": raw["ok"] ?? false, "proxyPath": "system", "proxies": proxy]
    }
    func status() throws -> [String: Any] { let id = try identity(); return ["iface": id.interface, "interface": id.interface, "service": id.service, "ip": id.ip, "gateway": id.gateway, "addressMethod": id.method, "linkAvailable": !id.ip.isEmpty, "online": NSNull(), "version": nativeVersion] }
    func flush() throws { try command("/usr/bin/dscacheutil", ["-flushcache"]); try command("/usr/bin/killall", ["-HUP", "mDNSResponder"]) }
    func setDNS(_ service: String, _ values: [String]) throws {
        try verifyService(service); guard values.allSatisfy(isIP) else { throw fail("INVALID_REQUEST", "备份 DNS 无效") }
        _ = try setup("-setdnsservers", service, values.isEmpty ? ["empty"] : values)
        guard try dns(service) == values else { throw fail("VERIFY_FAILED", "DNS 配置回读不匹配") }; try flush()
    }
    func vpnStatus(_ config: [String: Any]) throws -> [String: Any] {
        let c = config["company"] as! [String: Any], v = config["vpn"] as! [String: Any]
        guard v["enabled"] as? Bool == true, let probe = c["internalProbeIP"] as? String, !probe.isEmpty else { return ["disabled": true, "vpnConnected": false, "detail": "VPN 功能未配置"] }
        let r = try route(probe), iface = r["interface"] ?? "", connected = iface.hasPrefix("utun") || iface.hasPrefix("tun")
        let host = c["internalHost"] as? String ?? "", ips = host.isEmpty ? [] : ((try? resolve(host)) ?? [])
        let resolver = c["resolverDomain"] as? String ?? ""
        return ["vpnConnected": connected, "routeInterface": iface, "systemGitlabIp": ips.first ?? "", "systemDnsOk": ips.contains { containsIP($0, cidr: c["intranetCIDR"] as? String ?? "") }, "resolverInstalled": !resolver.isEmpty && fm.fileExists(atPath: "/etc/resolver/" + resolver), "detail": connected ? "检测到 VPN 路由" : "未检测到公司 VPN 路由"]
    }
}
func containsIP(_ ip: String, cidr: String) -> Bool {
    guard isCIDR(cidr) else { return false }; let parts = cidr.split(separator: "/"); var address = in_addr(), network = in_addr()
    guard ip.withCString({ inet_pton(AF_INET, $0, &address) }) == 1, String(parts[0]).withCString({ inet_pton(AF_INET, $0, &network) }) == 1 else { return false }
    let prefix = UInt32(parts[1])!, mask: UInt32 = prefix == 0 ? 0 : UInt32.max << (32 - prefix)
    return UInt32(bigEndian: address.s_addr) & mask == UInt32(bigEndian: network.s_addr) & mask
}
final class Repairs {
    let network: Network; let state: String; let uid: uid_t
    init(network: Network, state: String = privilegedState, uid: uid_t = 0) { self.network = network; self.state = state; self.uid = uid }
    func backup(_ name: String, _ make: () throws -> [String: Any]) throws -> [String: Any] {
        let path = state + "/" + name + "-backup.json"
        if fm.fileExists(atPath: path) { try securePath(path, uid: uid, directory: false, mode: 0o600); return try decodeObject(Data(contentsOf: URL(fileURLWithPath: path))) }
        let snap = try make(); try atomicJSON(snap, path: path, uid: uid); return snap
    }
    func saved(_ name: String) throws -> [String: Any] {
        let path = state + "/" + name + "-backup.json"
        guard fm.fileExists(atPath: path) else { throw fail("NO_BACKUP", "没有可恢复的原始配置") }; try securePath(path, uid: uid, directory: false, mode: 0o600)
        return try decodeObject(Data(contentsOf: URL(fileURLWithPath: path)))
    }
    func complete(_ name: String) throws { try fm.removeItem(atPath: state + "/" + name + "-backup.json") }
    func service(_ snap: [String: Any]) throws -> String { guard let service = snap["service"] as? String, !service.isEmpty else { throw fail("BACKUP_INVALID", "备份缺少网络服务") }; try network.verifyService(service); return service }
    func ensureSame(_ snap: [String: Any], _ current: String) throws { guard try service(snap) == current else { throw fail("SNAPSHOT_PENDING", "另一网络服务有待恢复配置，请先恢复") } }
    func perform(_ request: Request) throws -> [String: Any] {
        switch request.action {
        case "helper-status": return ["installed": true, "privileged": true, "version": nativeVersion, "message": "授权身份与版本已验证"]
        case "flush-dns": try network.flush(); return ["message": "DNS 缓存已刷新"]
        case "set-dns":
            let id = try network.identity(), snap = try backup("dns") { ["service": id.service, "dns": try network.dns(id.service)] }; try ensureSame(snap, id.service)
            let primary = request.args["primary"] as! String, secondary = request.args["secondary"] as? String ?? ""
            let values = primary == "empty" ? [] : [primary] + (secondary.isEmpty ? [] : [secondary])
            do { try network.setDNS(id.service, values)
                if !values.isEmpty {
                    var usable = false
                    for value in values { let r = try network.command("/usr/bin/dig", ["+short", "+time=2", "+tries=1", "@" + value, "www.baidu.com"], timeout: 3, allowFailure: true); if r.status == 0 && r.output.split(separator: "\n").contains(where: { isIP(String($0)) }) { usable = true; break } }
                    guard usable else { throw fail("DNS_UNREACHABLE", "新 DNS 无法解析公网域名；已恢复原始设置") }
                }
            }
            catch { let original = error; guard let values = snap["dns"] as? [String] else { throw fail("BACKUP_INVALID", "DNS 备份无效") }; do { try network.setDNS(id.service, values) } catch { throw fail("ROLLBACK_FAILED", "DNS 更新失败且恢复失败；原始备份保留") }; throw original }
            return ["message": "DNS 设置已回读确认，可恢复原始配置"]
        case "restore-dns":
            let snap = try saved("dns"), service = try service(snap); guard let values = snap["dns"] as? [String] else { throw fail("BACKUP_INVALID", "DNS 备份无效") }
            try network.setDNS(service, values); try complete("dns"); return ["message": "原始 DNS 配置已恢复并回读确认"]
        case "renew-dhcp":
            let id = try network.identity(); guard id.method == "DHCP" else { throw fail(id.method == "Manual" ? "STATIC_IP" : "ADDRESS_METHOD_UNKNOWN", "只允许续租明确使用 DHCP 的物理接口") }
            try network.command("/usr/sbin/ipconfig", ["set", id.interface, "DHCP"], timeout: 25); return ["message": "已为 \(id.service) 请求 DHCP 续租"]
        case "clear-proxy":
            let id = try network.identity(), snap = try backup("proxy") { ["service": id.service, "proxy": try network.proxy(id.service)] }; try ensureSame(snap, id.service)
            let current = try network.proxy(id.service)
            for (key, flag) in [("web", "-setwebproxystate"), ("secure", "-setsecurewebproxystate"), ("socks", "-setsocksfirewallproxystate")] {
                if let p = current[key] as? [String: Any], p["enabled"] as? Bool == true, p["local"] as? Bool == true, p["reachable"] as? Bool == false { _ = try network.setup(flag, id.service, ["off"]) }
            }
            let after = try network.proxy(id.service)
            for key in ["web", "secure", "socks"] { if let old = current[key] as? [String: Any], old["enabled"] as? Bool == true, old["local"] as? Bool == true, old["reachable"] as? Bool == false, (after[key] as? [String: Any])?["enabled"] as? Bool != false { throw fail("VERIFY_FAILED", "失效代理未关闭") } }
            return ["message": "失效的本机代理已关闭；正常代理和 PAC 保持"]
        case "restore-proxy":
            let snap = try saved("proxy"), service = try service(snap); guard let proxy = snap["proxy"] as? [String: Any] else { throw fail("BACKUP_INVALID", "代理备份无效") }
            try restoreProxy(service, proxy); try complete("proxy"); return ["message": "原始代理配置已恢复并回读确认"]
        case "vpn-coexist": return try coexist(request.args["config"] as! [String: Any])
        case "vpn-coexist-reset": return try resetCoexist()
        default: throw fail("INVALID_REQUEST", "不支持的特权动作")
        }
    }
    func restoreProxy(_ service: String, _ proxy: [String: Any]) throws {
        let existing = try network.proxy(service)
        for (key, setter, state) in [("web", "-setwebproxy", "-setwebproxystate"), ("secure", "-setsecurewebproxy", "-setsecurewebproxystate"), ("socks", "-setsocksfirewallproxy", "-setsocksfirewallproxystate")] {
            guard let p = proxy[key] as? [String: Any], let enabled = p["enabled"] as? Bool, let host = p["host"] as? String, let port = p["port"] as? Int else { throw fail("BACKUP_INVALID", "代理备份缺字段") }
            if !host.isEmpty && port > 0 { guard (isIP(host) || isDomain(host) || host == "localhost"), (1...65535).contains(port) else { throw fail("BACKUP_INVALID", "代理端点备份无效") }
                let current = existing[key] as? [String: Any] ?? [:]
                if current["host"] as? String != host || current["port"] as? Int != port {
                    guard p["authenticated"] as? Bool != true else { throw fail("AUTHENTICATED_PROXY_NEEDS_MANUAL", "原代理需要认证且地址已变更；请在系统设置恢复，原始备份保留") }
                    _ = try network.setup(setter, service, [host, String(port)])
                }
            }
            else if enabled { throw fail("BACKUP_INVALID", "开启代理缺少有效端点") }
            _ = try network.setup(state, service, [enabled ? "on" : "off"])
        }
        guard let auto = proxy["auto"] as? [String: Any], let enabled = auto["enabled"] as? Bool, let url = auto["url"] as? String, let bypass = proxy["bypass"] as? [String] else { throw fail("BACKUP_INVALID", "PAC 或直连名单备份无效") }
        if !url.isEmpty { _ = try network.setup("-setautoproxyurl", service, [url]) }; _ = try network.setup("-setautoproxystate", service, [enabled ? "on" : "off"])
        _ = try network.setup("-setproxybypassdomains", service, bypass.isEmpty ? ["Empty"] : bypass)
        let read = try network.proxy(service)
        for key in ["web", "secure", "socks"] { let expected = proxy[key] as! [String: Any], actual = read[key] as! [String: Any]; guard expected["enabled"] as? Bool == actual["enabled"] as? Bool else { throw fail("VERIFY_FAILED", "代理开关回读不匹配") }; if !(expected["host"] as! String).isEmpty { guard expected["host"] as? String == actual["host"] as? String, expected["port"] as? Int == actual["port"] as? Int else { throw fail("VERIFY_FAILED", "代理地址回读不匹配") } } }
        guard read["bypass"] as? [String] == bypass, (read["auto"] as? [String: Any])?["enabled"] as? Bool == enabled, (read["auto"] as? [String: Any])?["url"] as? String == url else { throw fail("VERIFY_FAILED", "直连名单回读不匹配") }; try network.flush()
    }
    func routeTable() throws -> [[String: String]] {
        let raw = try network.command("/usr/sbin/netstat", ["-rn", "-f", "inet"]).output
        return raw.split(separator: "\n").compactMap { line in
            let fields = line.split(whereSeparator: { $0 == " " || $0 == "\t" }).map(String.init)
            guard fields.count >= 4, let destination = canonicalRoute(fields[0]) else { return nil }
            let gateway = fields[1], interface = fields.first(where: { matches($0, #"^(en|utun|tun)[0-9]+$"#) }) ?? ""
            guard isIP(gateway) || matches(interface, #"^(en|utun|tun)[0-9]+$"#) else { return nil }
            return ["destination": destination, "gateway": gateway, "interface": interface]
        }
    }
    func routeCommand(_ operation: String, _ route: [String: String]) throws {
        guard let destination = route["destination"], isCIDR(destination), let gateway = route["gateway"], let interface = route["interface"] else { throw fail("BACKUP_INVALID", "路由备份无效") }
        var args = ["-n", operation, "-net", destination]
        if isIP(gateway) { args += [gateway] } else { guard matches(interface, #"^(en|utun|tun)[0-9]+$"#) else { throw fail("BACKUP_INVALID", "路由接口无效") }; args += ["-interface", interface] }
        try network.command("/sbin/route", args)
    }
    func removeIfPresent(_ destination: String) throws { if let route = try routeTable().first(where: { $0["destination"] == destination }) { try routeCommand("delete", route) } }
    func resolverPath(_ domain: String) throws -> String {
        guard isDomain(domain) else { throw fail("INVALID_REQUEST", "分域 DNS 域名无效") }
        #if TESTING
        return state + "/resolver-" + domain
        #else
        if fm.fileExists(atPath: "/etc/resolver") { try securePath("/etc/resolver", uid: 0, directory: true) }
        else { try fm.createDirectory(atPath: "/etc/resolver", withIntermediateDirectories: false, attributes: [.posixPermissions: 0o755]) }
        return "/etc/resolver/" + domain
        #endif
    }
    func resolverSnapshot(_ domain: String) throws -> [String: Any] {
        let path = try resolverPath(domain); var st = stat()
        guard lstat(path, &st) == 0 else { guard errno == ENOENT else { throw fail("READ_FAILED", "分域 DNS 读取失败") }; return ["existed": false] }
        try securePath(path, uid: uid, directory: false)
        let data = try Data(contentsOf: URL(fileURLWithPath: path)); guard data.count <= 65536 else { throw fail("READ_FAILED", "分域 DNS 文件过大") }
        return ["existed": true, "content": data.base64EncodedString(), "mode": Int(st.st_mode & 0o777)]
    }
    func writeResolver(_ domain: String, _ data: Data, mode: mode_t = 0o644) throws {
        let path = try resolverPath(domain), parent = URL(fileURLWithPath: path).deletingLastPathComponent().path
        if fm.fileExists(atPath: path) { try securePath(path, uid: uid, directory: false) }
        let temp = parent + "/.nettools-" + UUID().uuidString, fd = open(temp, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600)
        guard fd >= 0 else { throw fail("WRITE_FAILED", "无法准备分域 DNS") }; defer { close(fd); unlink(temp) }
        guard data.withUnsafeBytes({ Darwin.write(fd, $0.baseAddress, data.count) }) == data.count, fsync(fd) == 0, fchmod(fd, mode) == 0, rename(temp, path) == 0 else { throw fail("WRITE_FAILED", "分域 DNS 保存失败") }
        guard try Data(contentsOf: URL(fileURLWithPath: path)) == data else { throw fail("VERIFY_FAILED", "分域 DNS 回读失败") }
    }
    func coexist(_ config: [String: Any]) throws -> [String: Any] {
        let config = try configValue(config), c = config["company"] as! [String: Any], v = config["vpn"] as! [String: Any]
        let probe = c["internalProbeIP"] as! String, cidr = c["intranetCIDR"] as! String, resolver = c["resolverDomain"] as! String, dns = c["intranetDNS"] as! [String], host = c["internalHost"] as! String
        guard v["enabled"] as? Bool == true, !probe.isEmpty, !cidr.isEmpty, !resolver.isEmpty, !dns.isEmpty, !host.isEmpty, !dns.contains(where: { $0.contains(":") }) else { throw fail("VPN_UNSUPPORTED", "VPN 共存需要完整 IPv4 网段、DNS、探针与分域配置") }
        let route = try network.route(probe), interface = route["interface"] ?? "", gateway = route["gateway"] ?? ""
        guard matches(interface, #"^(utun|tun)[0-9]+$"#) else { throw fail("VPN_NOT_CONNECTED", "探针没有经过 VPN，未修改路由") }
        let id = try network.identity(), table = try routeTable(), destinations = [cidr] + dns.map { $0 + "/32" }
        let snapshot = try backup("coexist") { ["service": id.service, "dns": try network.dns(id.service), "bypass": try network.bypass(id.service), "resolverDomain": resolver, "resolver": try resolverSnapshot(resolver), "routes": table.filter { destinations.contains($0["destination"] ?? "") || ["0.0.0.0/1", "128.0.0.0/1"].contains($0["destination"] ?? "") }, "added": destinations, "gateway": gateway, "interface": interface] }
        try ensureSame(snapshot, id.service); guard snapshot["resolverDomain"] as? String == resolver else { throw fail("SNAPSHOT_PENDING", "另一套 VPN 共存配置待恢复") }
        for destination in destinations { try removeIfPresent(destination); try routeCommand("add", ["destination": destination, "gateway": gateway, "interface": interface]) }
        for destination in ["0.0.0.0/1", "128.0.0.0/1"] { try removeIfPresent(destination) }
        try writeResolver(resolver, Data((dns.map { "nameserver " + $0 }.joined(separator: "\n") + "\ntimeout 3\n").utf8))
        var bypass = try network.bypass(id.service); for domain in ["*." + resolver, host] where !bypass.contains(domain) { bypass.append(domain) }; _ = try network.setup("-setproxybypassdomains", id.service, bypass)
        if try network.dns(id.service).contains(where: dns.contains) { try network.setDNS(id.service, []) }; try network.flush()
        let after = try network.route(probe); guard matches(after["interface"] ?? "", #"^(utun|tun)[0-9]+$"#), try routeTable().allSatisfy({ !["0.0.0.0/1", "128.0.0.0/1"].contains($0["destination"] ?? "") }), try network.bypass(id.service).contains(host) else { throw fail("VERIFY_FAILED", "VPN 共存有项目未生效；原始备份保留") }
        return ["message": "VPN 精确路由、分域 DNS 与直连名单已应用并回读确认", "allOk": true]
    }
    func resetCoexist() throws -> [String: Any] {
        let snapshot = try saved("coexist"), service = try service(snapshot)
        guard let domain = snapshot["resolverDomain"] as? String, let resolver = snapshot["resolver"] as? [String: Any], let existed = resolver["existed"] as? Bool, let dns = snapshot["dns"] as? [String], let bypass = snapshot["bypass"] as? [String], let added = snapshot["added"] as? [String], let routes = snapshot["routes"] as? [[String: String]] else { throw fail("BACKUP_INVALID", "VPN 共存备份无效") }
        if existed { guard let raw = resolver["content"] as? String, let data = Data(base64Encoded: raw), let mode = resolver["mode"] as? Int, mode & 0o022 == 0 else { throw fail("BACKUP_INVALID", "分域 DNS 备份无效") }; try writeResolver(domain, data, mode: mode_t(mode)) }
        else { let path = try resolverPath(domain); if fm.fileExists(atPath: path) { try securePath(path, uid: uid, directory: false); try fm.removeItem(atPath: path) } }
        try network.setDNS(service, dns); _ = try network.setup("-setproxybypassdomains", service, bypass.isEmpty ? ["Empty"] : bypass)
        guard try network.bypass(service) == bypass else { throw fail("VERIFY_FAILED", "原直连名单恢复失败") }
        for destination in added { guard isCIDR(destination) else { throw fail("BACKUP_INVALID", "路由备份无效") }; try removeIfPresent(destination) }
        for route in routes { try removeIfPresent(route["destination"] ?? ""); try routeCommand("add", route) }
        try network.flush(); try complete("coexist"); return ["message": "原网络服务的 DNS、直连名单、分域文件和路由已恢复"]
    }
}
func canonicalRoute(_ value: String) -> String? {
    if value == "default" { return nil }
    let bits = value.split(separator: "/", omittingEmptySubsequences: false), address = bits[0].split(separator: ".").map(String.init)
    guard address.count <= 4, !address.isEmpty, address.allSatisfy({ Int($0).map { $0 >= 0 && $0 <= 255 } ?? false }) else { return nil }
    let expanded = (address + Array(repeating: "0", count: 4 - address.count)).joined(separator: ".")
    let prefix = bits.count == 2 ? String(bits[1]) : String(address.count * 8), result = expanded + "/" + prefix
    return isCIDR(result) ? result : nil
}
func authenticateHelper() throws -> [String: Any] {
    guard geteuid() == 0, getuid() != 0 else { throw fail("PERMISSION_REQUIRED", "需要为当前用户安装网络授权") }
    for parent in ["/Library", "/Library/PrivilegedHelperTools", "/Library/Application Support", privilegedState] { try securePath(parent, uid: 0, directory: true) }
    try securePath(installedHelper, uid: 0, directory: false, mode: 0o4755); try securePath(grantFile, uid: 0, directory: false, mode: 0o600)
    let grant = try decodeObject(Data(contentsOf: URL(fileURLWithPath: grantFile)))
    var buffer = [CChar](repeating: 0, count: 4096)
    guard proc_pidpath(getppid(), &buffer, UInt32(buffer.count)) > 0 else { throw fail("PERMISSION_DENIED", "无法验证调用程序") }
    let parent = String(cString: buffer)
    guard grant["installerUID"] as? Int == Int(getuid()), grant["version"] as? String == nativeVersion,
          grant["engineHash"] as? String == (try sha256(parent)), grant["helperHash"] as? String == (try sha256(installedHelper)) else { throw fail("PERMISSION_REQUIRED", "授权用户、执行程序或版本不匹配，请重新安装授权") }; return grant
}
#if HELPER
@main struct HelperMain {
    static func main() {
        NativeRegistry.shared.installSignals()
        var fixtureRunner: FixtureRunnerProxy?
        do {
            let object = try readInput(), request = try validate(object, helper: true)
            if CommandLine.arguments == [CommandLine.arguments[0], "--validate-only"] { reply(["valid": true, "version": nativeVersion]); return }
            #if TESTING
            if CommandLine.arguments == [CommandLine.arguments[0], "--fixture"], let fixture = object["fixture"] as? [String: Any], let state = fixture["stateDir"] as? String, state.hasPrefix(NSTemporaryDirectory()) || state.hasPrefix("/var/folders/") || state.hasPrefix("/tmp/") {
                let runner = FixtureRunner(fixture); fixtureRunner = runner
                let result = try Repairs(network: Network(runner), state: state, uid: getuid()).perform(request); reply(result, extra: ["commands": runner.commands]); return
            }
            #endif
            guard CommandLine.arguments == [CommandLine.arguments[0], "--rpc"] else { throw fail("INVALID_REQUEST", "仅接受固定 JSON 接口") }
            _ = try authenticateHelper()
            let lockPath = privilegedState + "/action.lock", fd = open(lockPath, O_CREAT | O_RDWR | O_NOFOLLOW, 0o600)
            guard fd >= 0 else { throw fail("BUSY", "无法锁定授权操作") }; defer { close(fd) }
            try securePath(lockPath, uid: 0, directory: false, mode: 0o600); guard flock(fd, LOCK_EX | LOCK_NB) == 0 else { throw fail("BUSY", "另一网络操作正在执行") }
            reply(try Repairs(network: Network()).perform(request))
        } catch { reply(error: error, extra: fixtureRunner.map { ["commands": $0.commands] } ?? [:]) }
    }
}
#endif
#if TESTING
typealias FixtureRunnerProxy = FixtureRunner
#else
struct FixtureRunnerProxy { let commands: [[String: Any]] }
#endif
