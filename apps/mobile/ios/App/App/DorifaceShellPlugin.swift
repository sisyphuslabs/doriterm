import Capacitor
import UIKit

/// `DorifaceShell`: the page hands the shell its background, so the area around the web view and the status bar's
/// text follow the theme in view, as on Android and in the desktop app.
@objc(DorifaceShellPlugin)
public class DorifaceShellPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "DorifaceShellPlugin"
    public let jsName = "DorifaceShell"
    public let pluginMethods: [CAPPluginMethod] = [CAPPluginMethod(name: "setBackground", returnType: CAPPluginReturnPromise)]

    @objc func setBackground(_ call: CAPPluginCall) {
        let css = call.getString("color", "")
        guard css.count == 7, css.hasPrefix("#"), let value = UInt32(css.dropFirst(), radix: 16) else {
            return call.reject("not a #rrggbb color: \(css)")
        }
        let r = CGFloat((value >> 16) & 0xff) / 255, g = CGFloat((value >> 8) & 0xff) / 255, b = CGFloat(value & 0xff) / 255
        // Rec. 709 luma: a background above the middle takes dark text in the status bar.
        let light = 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.5
        DispatchQueue.main.async {
            let color = UIColor(red: r, green: g, blue: b, alpha: 1)
            self.bridge?.viewController?.view.backgroundColor = color
            self.bridge?.webView?.backgroundColor = color
            self.bridge?.webView?.scrollView.backgroundColor = color
            (self.bridge?.viewController as? MainViewController)?.statusStyle = light ? .darkContent : .lightContent
            call.resolve()
        }
    }
}
