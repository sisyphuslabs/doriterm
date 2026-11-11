param([Parameter(Mandatory = $true)][string]$Output)
$ErrorActionPreference = "Stop"
$voice = New-Object -ComObject SAPI.SpVoice
$voices = $voice.GetVoices("Language=409")
if ($voices.Count -eq 0) { throw "No installed en-US SAPI TTS voice for the WAV recognition probe." }
$voice.Voice = $voices.Item(0)
$stream = New-Object -ComObject SAPI.SpFileStream
try {
  # SAFT22kHz16BitMono, SSFMCreateForWrite. Both synthesis and recognition stay local.
  $stream.Format.Type = 22
  $stream.Open($Output, 3, $false)
  $voice.AudioOutputStream = $stream
  [void]$voice.Speak("Hello world. This is a speech recognition test.")
} finally {
  $stream.Close()
  [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($stream)
  [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($voice)
}
