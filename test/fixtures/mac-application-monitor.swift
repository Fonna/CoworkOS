import AppKit
import Darwin
import Foundation

NSApplication.shared.setActivationPolicy(.prohibited)

func ancestry(_ pid: pid_t) -> [Int] {
    var result = [Int](), current = pid
    for _ in 0..<24 {
        var info = proc_bsdinfo()
        guard proc_pidinfo(current, PROC_PIDTBSDINFO, 0, &info, Int32(MemoryLayout<proc_bsdinfo>.size)) == MemoryLayout<proc_bsdinfo>.size else { break }
        let parent = pid_t(info.pbi_ppid)
        if parent <= 1 || parent == current { break }
        result.append(Int(parent)); current = parent
    }
    return result
}

func record(_ app: NSRunningApplication) -> [String: Any] {
    return ["pid": Int(app.processIdentifier), "policy": app.activationPolicy.rawValue,
            "name": app.localizedName ?? "", "bundleId": app.bundleIdentifier ?? "",
            "executable": app.executableURL?.path ?? "", "parents": ancestry(app.processIdentifier)]
}

func emit(_ value: [String: Any]) {
    let data = try! JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data([10]))
}

let workspace = NSWorkspace.shared
let initial = workspace.runningApplications
var seen = Set(initial.map { $0.processIdentifier })
func inspect(_ app: NSRunningApplication) {
    if app.activationPolicy == .regular && !seen.contains(app.processIdentifier) {
        seen.insert(app.processIdentifier)
        emit(["event": "regular-app", "application": record(app)])
    }
}
let observer = workspace.notificationCenter.addObserver(forName: NSWorkspace.didLaunchApplicationNotification, object: nil, queue: .main) { notification in
    if let app = notification.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication { inspect(app) }
}
let poll = Timer.scheduledTimer(withTimeInterval: 0.02, repeats: true) { _ in
    for app in workspace.runningApplications { inspect(app) }
}
emit(["event": "ready", "applications": initial.map(record), "monitorPolicy": NSRunningApplication.current.activationPolicy.rawValue])
DispatchQueue.global().async {
    while let line = readLine() {
        guard let data = line.data(using: .utf8),
              let request = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let id = request["id"] as? String else { continue }
        DispatchQueue.main.async {
            for app in workspace.runningApplications { inspect(app) }
            emit(["event": "snapshot", "id": id, "applications": workspace.runningApplications.map(record)])
        }
    }
}
RunLoop.main.run()
