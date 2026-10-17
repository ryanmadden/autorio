import AppKit
import WebKit

let args = Array(CommandLine.arguments.dropFirst())
func option(_ name: String) -> String? {
    guard let i = args.firstIndex(of: name), i + 1 < args.count else { return nil }
    return args[i + 1]
}
func emit(_ value: [String: Any]) {
    let data = try! JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
    if let file = option("--result") { try? data.write(to: URL(fileURLWithPath: file), options: .atomic) }
}

final class RecordingWindow: NSObject, WKNavigationDelegate, NSWindowDelegate {
    let window: NSWindow
    let web = WKWebView(frame: .zero)
    let url: URL
    var reported = false
    var monitor: Timer?
    var closing = false
    var automaticClose = false
    init(url: URL) {
        self.url = url
        window = NSWindow(contentRect: CGRect(x: 0, y: 0, width: 470, height: 800),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        super.init()
        window.title = "Agent transcript"
        window.isReleasedWhenClosed = false
        window.minSize = NSSize(width: 280, height: 300)
        window.contentView = web
        window.backgroundColor = NSColor(calibratedRed: 0.063, green: 0.075, blue: 0.082, alpha: 1)
        window.delegate = self
        web.navigationDelegate = self
        web.setValue(false, forKey: "drawsBackground")
    }
    func report(_ result: [String: Any]) {
        guard !reported else { return }
        reported = true; emit(result)
    }
    func start() {
        window.center(); window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        web.load(URLRequest(url: url))
        // Watch the run file directly so manager shutdown cannot strand the window.
        monitor = Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { [weak self] _ in
            guard let self = self, self.reported, !self.closing, let file = option("--run-file"),
                  let data = try? Data(contentsOf: URL(fileURLWithPath: file)),
                  let run = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let state = run["state"] as? String,
                  ["completed", "failed", "stopped", "timed_out", "interrupted", "paused"].contains(state) else { return }
            self.closing = true; self.automaticClose = true; self.monitor?.invalidate()
            // Allow the page to drain final output before closing, like Terminal view.
            DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in self?.window.close() }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 10) { [weak self] in
            self?.report(["status": "failed", "message": "Recording page did not finish loading"])
        }
    }
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        let target = navigationAction.request.url
        decisionHandler(target?.scheme == url.scheme && target?.host == url.host && target?.port == url.port ? .allow : .cancel)
    }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        guard !reported else { return }
        report(["status": "opened", "pid": ProcessInfo.processInfo.processIdentifier, "window_id": window.windowNumber])
    }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        report(["status": "failed", "message": error.localizedDescription])
    }
    func windowWillClose(_ notification: Notification) {
        monitor?.invalidate()
        if let result = option("--result"),
           let data = try? JSONSerialization.data(withJSONObject: ["reason": automaticClose ? "run_ended" : "window_closed", "pid": ProcessInfo.processInfo.processIdentifier]) {
            let file = URL(fileURLWithPath: result).deletingLastPathComponent().appendingPathComponent("recording-window-exit.json")
            try? data.write(to: file, options: .atomic)
        }
        NSApp.terminate(nil)
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.regular)
if let rawURL = option("--recording-url") {
    guard let url = URL(string: rawURL), url.scheme == "http", url.host == "127.0.0.1",
          url.path == "/recording.html",
          let query = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems,
          query.contains(where: { $0.name == "run" && !($0.value ?? "").isEmpty }) else {
        emit(["status": "failed", "message": "Invalid local recording URL"]); exit(0)
    }
    let menu = NSMenu(), item = NSMenuItem(), applicationMenu = NSMenu()
    applicationMenu.addItem(withTitle: "Quit Recording Window", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
    item.submenu = applicationMenu; menu.addItem(item); app.mainMenu = menu
    let recording = RecordingWindow(url: url)
    recording.start()
    withExtendedLifetime(recording) { app.run() }
    exit(0)
}

exit(0)
