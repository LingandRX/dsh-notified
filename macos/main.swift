//
//  main.swift — the macOS delivery half of dsh-notified.
//
//  This program is compiled by lib/darwin.js into a small `.app` bundle and
//  driven by the DSH host process. It exists because the two obvious channels
//  are both closed to a host-side plugin:
//
//  - Electron's own `Notification` class is unreachable: the host runs with
//    `ELECTRON_RUN_AS_NODE=1`, and asking for Electron's notification binding
//    through `process._linkedBinding` terminates the process outright.
//  - `osascript -e 'display notification'` works, but the banner is attributed
//    to Script Editor, so it can never be branded as DeepSeek Harness.
//
//  What remains is the real API, `UserNotifications`, and it refuses to run
//  outside an application bundle: `currentNotificationCenter()` aborts with
//  "bundleProxyForCurrentProcess is nil" for a bare binary. Hence the bundle.
//
//  Two non-obvious mechanisms decide the shape of this file, both measured
//  against macOS 27 on this machine:
//
//  1. The helper must be started by LaunchServices, not merely exec'd. A child
//     spawned straight from node is not recognised as an application instance:
//     the notification daemon logs "Failed to find or validate client of
//     identifier <id> with audit token ..." and `requestAuthorization` returns
//     "Notifications are not allowed for this application" without ever showing
//     a prompt. Launching the bundle through `open` first (which is what
//     lib/darwin.js does) teaches the daemon the bundle path behind the
//     identifier, after which the app is a first-class client.
//
//  2. Because `open` gives the parent no way to speak to the child, stdin is not
//     available as a request channel. The helper instead listens on a Unix
//     domain socket, and the host connects to it. That keeps the
//     LaunchServices-owned launch (needed for 1) and still allows ordinary
//     request/reply traffic.
//
//  The permission prompt is raised lazily, on the first real notification, and
//  that notification is held until the user answers rather than being dropped.
//

import AppKit
import Foundation
import UserNotifications

// A host that dies mid-write must not take this process down with a signal:
// losing a client is normal and is handled as end-of-stream.
signal(SIGPIPE, SIG_IGN)

/// Exit codes, deliberately identical to the Windows child's (lib/toast.js) so
/// the host-side outcome mapping stays uniform across platforms.
let exitSuppressed: Int32 = 3
let exitUnavailable: Int32 = 4
let exitRejected: Int32 = 5

/// One notification request, as written by the host on the socket.
struct Request: Decodable {
    /// `notify` (default) or `status`, the latter answering without sending.
    let kind: String?
    /// Correlates a reply with its request. A `status` probe may omit it.
    let id: String?
    let title: String?
    let body: String?
    let launch: String?
    let group: String?
    let duration: String?
    let sound: Bool?
    let suppressWhenFocused: Bool?
    let foregroundBundleIds: [String]?
}

/// One reply line, as written back to the host. Optional fields are omitted by
/// the synthesized encoder, so each reply carries only what it means.
struct Reply: Encodable {
    let id: String?
    let event: String?
    let ok: Bool?
    let suppressed: Bool?
    let code: Int?
    let reason: String?
    let authStatus: String?
    let detail: String?
    let bundle: String?
    let pid: Int?
    let front: String?
}

/// Render an authorization status as a stable, log-friendly token.
func statusName(_ status: UNAuthorizationStatus) -> String {
    switch status {
    case .notDetermined: return "notDetermined"
    case .denied: return "denied"
    case .authorized: return "authorized"
    case .provisional: return "provisional"
    case .ephemeral: return "ephemeral"
    @unknown default: return "unknown"
    }
}

/// Serialise one reply as a single JSON line.
func encodeLine(_ reply: Reply) -> Data {
    guard let data = try? JSONEncoder().encode(reply) else { return Data() }
    var line = data
    line.append(0x0A)
    return line
}

/// Handle the two delegate callbacks that matter.
final class Delegate: NSObject, UNUserNotificationCenterDelegate {
    /// Present banners even while this process is frontmost. Without this a
    /// banner raised while the notification centre considers the helper active
    /// would be swallowed instead of shown.
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        completionHandler([.banner, .sound])
    }

    /// A click on the banner: hand focus back to the desktop application through
    /// the `dsh://open` URL it already registers.
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        if let raw = response.notification.request.content.userInfo["launch"] as? String,
           let url = URL(string: raw) {
            NSWorkspace.shared.open(url)
        }
        completionHandler()
    }
}

/// The notification path: focus policy, authorization, and delivery.
final class Notifier {
    private let center = UNUserNotificationCenter.current()
    private let outputLock = NSLock()
    /// Latest observed authorization, reported alongside every reply so the host
    /// can explain a refusal without a second round trip.
    private var lastStatus: UNAuthorizationStatus = .notDetermined
    /// Whether the system will accept a time-sensitive interruption level. It
    /// requires an entitlement, so it is false for an ad-hoc signed bundle.
    private var timeSensitiveAllowed = false

    /// Write one reply to a connected client. Serialised per connection, so two
    /// completions cannot interleave halves of a line.
    func reply(_ reply: Reply, to connection: SocketClient) {
        outputLock.lock()
        defer { outputLock.unlock() }
        connection.write(encodeLine(reply))
    }

    /// Apply the focus policy, then deliver.
    func handle(_ request: Request, from connection: SocketClient) {
        if request.kind == "status" {
            reportStatus(to: connection)
            return
        }
        if request.kind == "shutdown" {
            reply(Reply(
                id: request.id, event: nil, ok: true, suppressed: false, code: 0, reason: nil,
                authStatus: statusName(lastStatus), detail: "shutting down",
                bundle: nil, pid: nil, front: nil
            ), to: connection)
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { exit(0) }
            return
        }
        if request.suppressWhenFocused == true {
            // Match on either identity. The desktop application reports its
            // bundle identifier ("com.deepseek.dsh"), while the Windows-facing
            // default in the shared config is a product name
            // ("DeepSeek Harness"), so accepting both keeps one setting working
            // on both platforms.
            let wanted = Set(request.foregroundBundleIds ?? [])
            let front = NSWorkspace.shared.frontmostApplication
            let frontId = front?.bundleIdentifier
            let frontName = front?.localizedName
            let matches = (frontId.map { wanted.contains($0) } ?? false)
                || (frontName.map { wanted.contains($0) } ?? false)
            if matches {
                reply(Reply(
                    id: request.id, event: nil, ok: true, suppressed: true,
                    code: Int(exitSuppressed), reason: nil,
                    authStatus: statusName(lastStatus),
                    detail: "frontmost=\(frontId ?? frontName ?? "unknown")",
                    bundle: nil, pid: nil, front: frontId
                ), to: connection)
                return
            }
        }

        center.getNotificationSettings { settings in
            self.lastStatus = settings.authorizationStatus
            self.timeSensitiveAllowed = settings.timeSensitiveSetting == .enabled
            switch settings.authorizationStatus {
            case .notDetermined:
                // The first notification is the natural moment to ask, and it is
                // held rather than dropped until the user answers.
                self.center.requestAuthorization(options: [.alert, .sound]) { granted, error in
                    self.center.getNotificationSettings { fresh in
                        self.lastStatus = fresh.authorizationStatus
                        self.timeSensitiveAllowed = fresh.timeSensitiveSetting == .enabled
                        if granted {
                            self.deliver(request, to: connection)
                        } else {
                            self.fail(
                                request, to: connection, reason: "denied",
                                detail: error?.localizedDescription
                                    ?? "the notification permission prompt was declined"
                            )
                        }
                    }
                }
            case .denied:
                self.fail(
                    request, to: connection, reason: "denied",
                    detail: "notifications are switched off for this app in System Settings"
                )
            default:
                self.deliver(request, to: connection)
            }
        }
    }

    /// Report the current authorization without sending anything, so the host
    /// can tell "needs permission" apart from "broken" on its first contact.
    func reportStatus(to connection: SocketClient) {
        center.getNotificationSettings { settings in
            self.lastStatus = settings.authorizationStatus
            self.timeSensitiveAllowed = settings.timeSensitiveSetting == .enabled
            self.reply(Reply(
                id: nil, event: "ready", ok: nil, suppressed: nil, code: nil, reason: nil,
                authStatus: statusName(settings.authorizationStatus), detail: nil,
                bundle: Bundle.main.bundleIdentifier,
                pid: Int(ProcessInfo.processInfo.processIdentifier),
                front: NSWorkspace.shared.frontmostApplication?.bundleIdentifier
            ), to: connection)
        }
    }

    private func deliver(_ request: Request, to connection: SocketClient) {
        let content = UNMutableNotificationContent()
        content.title = request.title ?? ""
        content.body = request.body ?? ""
        if let group = request.group, !group.isEmpty {
            // Groups a conversation's notifications so they stack in the
            // notification centre instead of scattering.
            content.threadIdentifier = group
        }
        if request.sound == true {
            content.sound = .default
        }
        // The click target travels with the notification, so a response stays
        // self-describing even if this process is later restarted.
        content.userInfo = ["launch": request.launch ?? "dsh://open"]
        // macOS has no short/long toast duration. `long` is mapped onto the one
        // related lever it does have: a time-sensitive notification, which is
        // allowed through Focus modes. It needs an entitlement, so it is applied
        // only when the system reports the setting as available.
        if request.duration == "long", timeSensitiveAllowed {
            content.interruptionLevel = .timeSensitive
        }

        // A stable identifier lets a re-sent notification replace the previous
        // one instead of stacking a duplicate.
        let identifier = request.id ?? UUID().uuidString
        let notification = UNNotificationRequest(identifier: identifier, content: content, trigger: nil)
        center.add(notification) { error in
            if let error {
                self.fail(request, to: connection, reason: "rejected", detail: error.localizedDescription)
                return
            }
            self.reply(Reply(
                id: request.id, event: nil, ok: true, suppressed: false, code: 0, reason: nil,
                authStatus: statusName(self.lastStatus), detail: nil,
                bundle: nil, pid: nil, front: nil
            ), to: connection)
        }
    }

    private func fail(_ request: Request, to connection: SocketClient, reason: String, detail: String) {
        reply(Reply(
            id: request.id, event: nil, ok: false, suppressed: false,
            code: Int(reason == "unavailable" ? exitUnavailable : exitRejected),
            reason: reason, authStatus: statusName(lastStatus), detail: detail,
            bundle: nil, pid: nil, front: nil
        ), to: connection)
    }
}

/// One accepted connection.
///
/// The owner must hold a strong reference for as long as the connection should
/// live: a `FileHandle` built with `closeOnDealloc` closes the descriptor as soon
/// as the last reference goes away, and the system's readability callbacks stop
/// with it. `SocketServer` keeps the live set, so a request that arrives after
/// the accept handler returns is still read.
final class SocketClient {
    let handle: FileHandle
    private var buffer = Data()
    private let onRequest: (Request, SocketClient) -> Void
    private let onClose: (SocketClient) -> Void
    private var closed = false

    init(handle: FileHandle, onRequest: @escaping (Request, SocketClient) -> Void, onClose: @escaping (SocketClient) -> Void) {
        self.handle = handle
        self.onRequest = onRequest
        self.onClose = onClose
    }

    func start() {
        handle.readabilityHandler = { [weak self] fileHandle in
            guard let self else { return }
            let chunk = fileHandle.availableData
            if chunk.isEmpty {
                // End of stream: the host finished its batch and hung up.
                self.close()
                return
            }
            self.buffer.append(chunk)
            while let newline = self.buffer.firstIndex(of: 0x0A) {
                let line = self.buffer.subdata(in: self.buffer.startIndex..<newline)
                self.buffer.removeSubrange(self.buffer.startIndex...newline)
                guard !line.isEmpty, let request = try? JSONDecoder().decode(Request.self, from: line) else { continue }
                self.onRequest(request, self)
            }
        }
    }

    func write(_ data: Data) {
        guard !data.isEmpty, !closed else { return }
        try? handle.write(contentsOf: data)
    }

    func close() {
        guard !closed else { return }
        closed = true
        handle.readabilityHandler = nil
        try? handle.close()
        onClose(self)
    }
}

/// The Unix socket listener, holding the live connection set.
final class SocketServer {
    private let notifier: Notifier
    private let queue: DispatchQueue
    private var descriptor: Int32 = -1
    private var clients: [ObjectIdentifier: SocketClient] = [:]

    init(notifier: Notifier, queue: DispatchQueue) {
        self.notifier = notifier
        self.queue = queue
    }

    /// Bind and listen. Returns false when the socket could not be created,
    /// which the entry point reports as an unavailable channel.
    func listen(at path: String) -> Bool {
        // A socket left behind by a crashed instance would block the bind.
        try? FileManager.default.removeItem(atPath: path)
        try? FileManager.default.createDirectory(
            atPath: (path as NSString).deletingLastPathComponent,
            withIntermediateDirectories: true
        )

        descriptor = socket(AF_UNIX, SOCK_STREAM, 0)
        guard descriptor >= 0 else { return false }

        var address = sockaddr_un()
        address.sun_family = sa_family_t(AF_UNIX)
        let capacity = MemoryLayout.size(ofValue: address.sun_path)
        let pathBytes = Array(path.utf8)
        guard pathBytes.count < capacity else { return false }
        withUnsafeMutablePointer(to: &address.sun_path) { pointer in
            pointer.withMemoryRebound(to: CChar.self, capacity: capacity) { destination in
                for (offset, byte) in pathBytes.enumerated() { destination[offset] = CChar(bitPattern: byte) }
                destination[pathBytes.count] = 0
            }
        }

        let bound = withUnsafePointer(to: &address) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                bind(descriptor, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
            }
        }
        guard bound == 0, Darwin.listen(descriptor, 16) == 0 else { return false }

        let source = DispatchSource.makeReadSource(fileDescriptor: descriptor, queue: queue)
        source.setEventHandler { [weak self] in
            guard let self else { return }
            let client = accept(self.descriptor, nil, nil)
            guard client >= 0 else { return }
            let handle = FileHandle(fileDescriptor: client, closeOnDealloc: true)
            let connection = SocketClient(
                handle: handle,
                onRequest: { [weak self] request, sender in self?.notifier.handle(request, from: sender) },
                onClose: { [weak self] finished in self?.clients.removeValue(forKey: ObjectIdentifier(finished)) }
            )
            self.clients[ObjectIdentifier(connection)] = connection
            connection.start()
        }
        source.resume()
        self.source = source
        return true
    }

    private var source: DispatchSourceRead?
}

// MARK: - Entry point

/// Where the host connects.
///
/// A `--socket <path>` argument overrides it, but the default sits beside the
/// bundle so that the helper needs no arguments at all. That is deliberate:
/// LaunchServices is the only launcher that makes this process a first-class
/// notification client, and the reliable way to invoke it is a bare
/// `open -a <bundle>`, which cannot carry arguments.
func socketPath() -> String {
    let arguments = CommandLine.arguments
    if let index = arguments.firstIndex(of: "--socket"), index + 1 < arguments.count {
        return arguments[index + 1]
    }
    let parent = (Bundle.main.bundlePath as NSString).deletingLastPathComponent
    return (parent as NSString).appendingPathComponent("helper.sock")
}

let delegate = Delegate()

// A real NSApplication is required for the notification centre to deliver
// clicks; `.accessory` keeps the helper out of the Dock and the app switcher.
_ = NSApplication.shared
NSApp.setActivationPolicy(.accessory)
UNUserNotificationCenter.current().delegate = delegate

// One process serves both jobs. It is the resident request server *and* the
// click handler: LaunchServices starts it on first use, later `open` calls just
// wake the instance that is already there, and a banner click is delivered to
// this same process through the delegate above.
let path = socketPath()
let notifier = Notifier()
let work = DispatchQueue(label: "dsh-notified.socket")
let server = SocketServer(notifier: notifier, queue: work)

guard server.listen(at: path) else {
    FileHandle.standardError.write(encodeLine(Reply(
        id: nil, event: "error", ok: false, suppressed: nil, code: Int(exitUnavailable),
        reason: "unavailable", authStatus: nil, detail: "could not listen on \(path)",
        bundle: nil, pid: nil, front: nil
    )))
    exit(exitUnavailable)
}

// Announce the way in, so a failure is diagnosable from the log alone instead
// of looking like a silent no-op.
FileHandle.standardError.write(encodeLine(Reply(
    id: nil, event: "listening", ok: nil, suppressed: nil, code: nil, reason: nil,
    authStatus: nil, detail: path,
    bundle: Bundle.main.bundleIdentifier,
    pid: Int(ProcessInfo.processInfo.processIdentifier), front: nil
)))

RunLoop.main.run()
