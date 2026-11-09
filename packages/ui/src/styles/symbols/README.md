# Apple pin symbol rendering

These Apple-platform renderings come directly from AppKit's `NSImage(systemSymbolName:)`, names `pin` and `pin.fill`,
using `NSImage.SymbolConfiguration(pointSize: 14, weight: .regular)`. Both report a natural size of 17 by 18 points.
Each is centered in a fixed 20-point square and rendered separately into 20-by-20, 40-by-40 and 60-by-60 pixel alpha images.
The 2x and 3x images are rendered from the system symbol again, never resized from the 1x image.
Both states have the same nontransparent pixel bounds: `(4, 2)-(16, 18)` at 1x and `(8, 4)-(32, 36)` at 2x.
The visible symbol is therefore 12 by 16 CSS pixels in either state, centered in the same slot.

`PinSymbol` selects the display density with `image-set` and keeps the same 20 CSS pixel slot in every interaction state.
Colour comes from the control through the alpha mask. These assets are selected only on Apple platforms; other
platforms use the stock Lucide pin SVG with the same slot and outline/filled distinction.

The images contain only the two system symbols. They are not screenshots of an application or a user's display.
