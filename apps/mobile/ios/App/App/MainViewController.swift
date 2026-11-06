import Capacitor
import UIKit

/// The bridge view controller with doriface's own plugins registered and a status bar that follows the page's theme.
class MainViewController: CAPBridgeViewController {
    var statusStyle: UIStatusBarStyle = .default {
        didSet { setNeedsStatusBarAppearanceUpdate() }
    }

    override var preferredStatusBarStyle: UIStatusBarStyle { statusStyle }

    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(DorifacePushPlugin())
        bridge?.registerPluginInstance(DorifaceShellPlugin())
    }
}
