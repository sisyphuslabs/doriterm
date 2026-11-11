### Corrections to earlier release notes

- The v0.1.17 notes credit #1937 with the keyboard button raising the soft keyboard in the tap itself; that button was
  already doing so. What #1937 changed: closing Switch session keeps the keyboard up, because the terminal takes the
  focus inside the closing tap, and a session picked from Switch session opens with the keyboard down. (#1937)
