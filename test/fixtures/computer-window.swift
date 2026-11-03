import AppKit
final class Delegate: NSObject, NSApplicationDelegate, NSTextFieldDelegate {
    var window: NSWindow!
    var input: NSTextField!
    var document: NSTextView!
    var otherWindow: NSWindow?
    let root = CommandLine.arguments[1]
    var timer: Timer?
    var lastCommand = ""
    func applicationDidFinishLaunching(_ notification: Notification) {
        let menu = NSMenu()
        let editItem = NSMenuItem(title: "Edit", action: nil, keyEquivalent: "")
        let edit = NSMenu(title: "Edit")
        edit.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editItem.submenu = edit; menu.addItem(editItem)
        NSApp.mainMenu = menu
        window = NSWindow(contentRect: NSRect(x: 180, y: 180, width: 640, height: 360), styleMask: [.titled, .closable], backing: .buffered, defer: false)
        window.title = "CoworkOS Computer Use Isolated Test"
        input = NSTextField(frame: NSRect(x: 30, y: 150, width: 580, height: 44))
        input.placeholderString = "Isolated input probe"
        input.setAccessibilityLabel("Probe input")
        input.setAccessibilityIdentifier("probe-input")
        input.stringValue = "Initial text must be replaced"
        input.delegate = self
        window.contentView!.addSubview(input)
        let scroll = NSScrollView(frame: NSRect(x: 30, y: 30, width: 580, height: 95))
        scroll.hasVerticalScroller = true
        document = NSTextView(frame: NSRect(x: 0, y: 0, width: 560, height: 95))
        document.isRichText = false
        document.font = NSFont.systemFont(ofSize: 15)
        scroll.documentView = document
        window.contentView!.addSubview(scroll)
        let save = NSButton(frame: NSRect(x: 490, y: 260, width: 120, height: 32))
        save.title = "Save probe"
        save.setAccessibilityIdentifier("probe-save")
        save.target = self; save.action = #selector(saveProbe)
        window.contentView!.addSubview(save)
        window.makeKeyAndOrderFront(nil)
        window.makeFirstResponder(input)
        NSEvent.addLocalMonitorForEvents(matching: [.keyDown, .leftMouseDown]) { event in
            self.emit(["event": event.type.rawValue, "characters": event.type == .keyDown ? (event.characters ?? "") : "", "flags": event.modifierFlags.rawValue, "window": event.windowNumber, "x": event.locationInWindow.x, "y": event.locationInWindow.y])
            return event
        }
        NSApp.activate(ignoringOtherApps: true)
        DispatchQueue.main.async {
            self.emit(["ready": true, "pid": Int(getpid()), "windowId": self.window.windowNumber])
        }
        timer = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { _ in
            guard let command = try? String(contentsOfFile: self.root + "/control", encoding: .utf8),
                  command != self.lastCommand else { return }
            self.lastCommand = command
            if command == "quit" { NSApp.terminate(nil) }
            if command == "move" {
                self.window.setFrameOrigin(NSPoint(x: 220, y: 220)); self.emit(["moved": true])
            }
            if command == "other" {
                self.otherWindow = NSWindow(contentRect: NSRect(x: 220, y: 220, width: 400, height: 200), styleMask: [.titled], backing: .buffered, defer: false)
                self.otherWindow!.title = "Unselected isolated window"
                self.otherWindow!.makeKeyAndOrderFront(nil)
                self.emit(["otherWindow": true])
            }
            if command == "replace" {
                let old = self.input!
                let replacement = NSTextField(frame: old.frame)
                replacement.placeholderString = old.placeholderString
                replacement.stringValue = old.stringValue
                replacement.setAccessibilityLabel("Probe input")
                replacement.setAccessibilityIdentifier("probe-input")
                replacement.delegate = self
                old.removeFromSuperview()
                self.window.contentView!.addSubview(replacement)
                self.input = replacement
                self.emit(["replaced": true])
            }
        }
    }
    @objc func saveProbe() {
        let value: [String: Any] = ["field": input.stringValue, "document": document.string]
        let data = try! JSONSerialization.data(withJSONObject: value)
        try! data.write(to: URL(fileURLWithPath: root + "/saved.json"), options: .atomic)
        emit(["saved": true])
    }
    func controlTextDidChange(_ notification: Notification) {
        if let field = notification.object as? NSTextField { emit(["text": field.stringValue]) }
    }
    func emit(_ value: [String: Any]) {
        let data = try! JSONSerialization.data(withJSONObject: value)
        let file = try! FileHandle(forWritingTo: URL(fileURLWithPath: root + "/events"))
        file.seekToEndOfFile(); file.write(data); file.write(Data([10])); try! file.close()
    }
}
let app = NSApplication.shared
let delegate = Delegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
